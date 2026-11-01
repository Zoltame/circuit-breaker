// The gate between an agent and its money. Every order goes: intent -> policy engine -> (quote) ->
// policy engine with quote -> paper fill -> journal. Nothing reaches the broker without an "allow".

import { evaluateOrder, type Decision, type Order, type Policy, type Side } from "@circuit-breaker/policy-engine";
import type { Execution, Journal, JournalEvent } from "./journal.ts";
import { findNearToken, fromBaseUnits, toBaseUnits, type Quoter, type TokenInfo } from "./oneclick.ts";
import { QUOTE_ASSET, type PaperBroker, type PaperState } from "./paper.ts";

export interface OrderIntent {
  agentId: string;
  side: Side;
  asset: string;
  notionalUsd: number;
  leverage?: number;
}

export type DecisionEvent = Extract<JournalEvent, { type: "decision" }>;

export interface CircuitBreakerDeps {
  policy: Policy;
  broker: PaperBroker;
  quoter: Quoter;
  journal: Journal;
  now?: () => number;
  newId?: () => string;
  /** Called after every state change (fill, kill-switch) so the caller can persist it. */
  onStateChange?: (state: PaperState) => void;
}

export class CircuitBreaker {
  private readonly now: () => number;
  private readonly newId: () => string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CircuitBreakerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  get policy(): Policy {
    return this.deps.policy;
  }

  /** Orders are processed one at a time so each evaluation sees the result of the previous one. */
  submit(intent: OrderIntent): Promise<DecisionEvent> {
    const run = this.queue.then(() => this.process(intent));
    this.queue = run.catch(() => undefined);
    return run;
  }

  setKillSwitch(on: boolean, by: string, reason: string): void {
    this.deps.broker.setKillSwitch(on);
    this.deps.journal.append({ type: "kill_switch", timestamp: new Date(this.now()).toISOString(), on, by, reason });
    this.deps.onStateChange?.(this.deps.broker.state);
  }

  /** Current prices (USD) for every asset the account holds or may trade. */
  async prices(): Promise<{ tokens: TokenInfo[]; prices: Record<string, number> }> {
    let tokens: TokenInfo[] = [];
    try {
      tokens = await this.deps.quoter.tokens();
    } catch {
      // Prices unavailable: positions are marked at 0, which can only make the engine stricter.
    }
    const prices: Record<string, number> = { [QUOTE_ASSET]: 1 };
    const symbols = new Set([...this.deps.policy.allowedAssets, ...Object.keys(this.deps.broker.state.holdings)]);
    for (const s of symbols) {
      const p = findNearToken(tokens, s)?.price;
      if (p !== undefined && s !== QUOTE_ASSET) prices[s] = p;
    }
    return { tokens, prices };
  }

  private async process(intent: OrderIntent): Promise<DecisionEvent> {
    const { policy, broker, journal } = this.deps;
    const now = this.now();
    const { tokens, prices } = await this.prices();
    const state = broker.mark(prices, now);
    const order: Order = {
      id: this.newId(),
      agentId: intent.agentId,
      side: intent.side,
      asset: intent.asset,
      notionalUsd: intent.notionalUsd,
      leverage: intent.leverage ?? 1,
    };
    const decisionId = this.newId();

    // Pass 1 without a quote: if any rule other than slippage blocks, don't even ask for a price.
    let decision: Decision = evaluateOrder({ order, state, policy, now, decisionId });
    let fill: { units: number; cashDelta: number } | null = null;

    if (decision.verdict === "block" && decision.triggeredRule === "max_slippage") {
      const quoted = await this.quote(order, tokens, prices);
      if (quoted) {
        order.quote = { amountInUsd: quoted.amountInUsd, amountOutUsd: quoted.amountOutUsd };
        fill = { units: quoted.units, cashDelta: quoted.cashDelta };
        decision = evaluateOrder({ order, state, policy, now, decisionId });
      }
    }

    let execution: Execution | undefined;
    if (decision.verdict === "allow" && fill) {
      try {
        if (order.leverage > 1) throw new Error("Paper broker is spot-only");
        broker.apply({ side: order.side, asset: order.asset, ...fill }, now);
        execution = { status: "filled", ...fill };
      } catch (err) {
        execution = { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (decision.effects.activateKillSwitch && !broker.state.killSwitch) {
      broker.setKillSwitch(true);
      journal.append({
        type: "kill_switch",
        timestamp: decision.timestamp,
        on: true,
        by: `policy:${decision.triggeredRule}`,
        reason: decision.reason,
      });
    }

    const event: DecisionEvent = {
      type: "decision",
      ...decision,
      ...(execution ? { execution } : {}),
      equityUsd: broker.equityUsd(prices),
    };
    journal.append(event);
    this.deps.onStateChange?.(broker.state);
    return event;
  }

  private async quote(
    order: Order,
    tokens: TokenInfo[],
    prices: Record<string, number>,
  ): Promise<{ amountInUsd: number; amountOutUsd: number; units: number; cashDelta: number } | null> {
    const usdc = findNearToken(tokens, QUOTE_ASSET);
    const asset = findNearToken(tokens, order.asset);
    const price = prices[order.asset];
    if (!usdc || !asset || !price) return null;
    const size = order.notionalUsd * order.leverage;
    try {
      if (order.side === "buy") {
        const q = await this.deps.quoter.dryQuote({
          originAssetId: usdc.assetId,
          destinationAssetId: asset.assetId,
          amount: toBaseUnits(size, usdc.decimals),
          slippageBps: this.deps.policy.maxSlippageBps,
        });
        return { ...q, units: fromBaseUnits(q.amountOut, asset.decimals), cashDelta: fromBaseUnits(q.amountIn, usdc.decimals) };
      }
      const q = await this.deps.quoter.dryQuote({
        originAssetId: asset.assetId,
        destinationAssetId: usdc.assetId,
        amount: toBaseUnits(size / price, asset.decimals),
        slippageBps: this.deps.policy.maxSlippageBps,
      });
      return { ...q, units: fromBaseUnits(q.amountIn, asset.decimals), cashDelta: fromBaseUnits(q.amountOut, usdc.decimals) };
    } catch {
      return null; // fail closed: the order stays blocked on max_slippage
    }
  }
}
