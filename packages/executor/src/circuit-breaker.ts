// The gate between an agent and its money. Every order goes: intent -> policy engine -> (quote) ->
// policy engine with quote -> on-chain vault (optional) -> paper fill -> journal.
// Nothing reaches the vault or the broker without an "allow".

import { evaluateOrder, type Decision, type Order, type Policy, type Side } from "@circuit-breaker/policy-engine";
import type { Execution, Journal, JournalEvent, OnchainLink } from "./journal.ts";
import { findNearToken, fromBaseUnits, toBaseUnits, type Quoter, type TokenInfo } from "./oneclick.ts";
import { QUOTE_ASSET, type PaperBroker, type PaperState } from "./paper.ts";
import type { OnchainResult, VaultGateway } from "./vault.ts";

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
  /** Optional on-chain vault. When set, buys must settle on-chain before the paper fill. */
  vault?: VaultGateway | undefined;
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

  get journal(): Journal {
    return this.deps.journal;
  }

  journalTail(n: number): JournalEvent[] {
    return this.deps.journal.read().slice(-n);
  }

  /** Re-emits the current state, e.g. after the caller reset the paper account. */
  persist(): void {
    this.deps.onStateChange?.(this.deps.broker.state);
  }

  /** Orders are processed one at a time so each evaluation sees the result of the previous one. */
  submit(intent: OrderIntent): Promise<DecisionEvent> {
    const run = this.queue.then(() => this.process(intent));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Manual kill-switch. Turning it on also freezes the on-chain vault; turning it off only releases
   * the off-chain gate: the vault stays frozen until its owner releases it with their own key.
   */
  setKillSwitch(on: boolean, by: string, reason: string): Promise<void> {
    const run = this.queue.then(async () => {
      this.deps.broker.setKillSwitch(on);
      const onchain = on ? await this.deps.vault?.tripKillSwitch(reason) : undefined;
      this.deps.journal.append({
        type: "kill_switch",
        timestamp: new Date(this.now()).toISOString(),
        on,
        by,
        reason,
        ...(onchain ? { onchain: this.withLink(onchain) } : {}),
      });
      this.deps.onStateChange?.(this.deps.broker.state);
    });
    this.queue = run.catch(() => undefined);
    return run;
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
      execution = await this.execute(order, fill, now);
    }

    if (decision.effects.activateKillSwitch && !broker.state.killSwitch) {
      broker.setKillSwitch(true);
      const onchain = await this.deps.vault?.tripKillSwitch(decision.reason);
      journal.append({
        type: "kill_switch",
        timestamp: decision.timestamp,
        on: true,
        by: `policy:${decision.triggeredRule}`,
        reason: decision.reason,
        ...(onchain ? { onchain: this.withLink(onchain) } : {}),
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

  /** Buys first go through the on-chain vault (if configured); the paper fill only happens if it settles. */
  private async execute(order: Order, fill: { units: number; cashDelta: number }, now: number): Promise<Execution> {
    try {
      if (order.leverage > 1) throw new Error("Paper broker is spot-only");
      let onchain: OnchainLink | undefined;
      if (this.deps.vault && order.side === "buy") {
        onchain = this.withLink(await this.deps.vault.executeOrder(order.id, order.notionalUsd));
        if (onchain.status !== "settled") {
          return { status: "failed", error: `vault ${onchain.status}: ${onchain.error ?? "unknown"}`, onchain };
        }
      }
      this.deps.broker.apply({ side: order.side, asset: order.asset, ...fill }, now);
      return { status: "filled", ...fill, ...(onchain ? { onchain } : {}) };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private withLink(r: OnchainResult): OnchainLink {
    return r.txHash && this.deps.vault ? { ...r, explorerUrl: this.deps.vault.explorerUrl(r.txHash) } : r;
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
