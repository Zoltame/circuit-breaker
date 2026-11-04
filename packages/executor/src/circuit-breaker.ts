// The gate between an agent and its money. Every order goes: intent -> policy engine -> (quote) ->
// policy engine with quote -> on-chain vault (optional) -> paper fill -> journal.
// Nothing reaches the vault or the broker without an "allow".

import { assessAgents, assessRisk, evaluateOrder, type Decision, type Order, type Policy, type Side } from "@circuit-breaker/policy-engine";
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
  /**
   * Sell the whole held position of `asset`. `notionalUsd` is ignored and replaced by the position's value
   * at the prices used for this very evaluation, so an exit can never overshoot what is held.
   */
  closePosition?: boolean;
}

/** Positions worth less than this (USD) are float dust, not something to unwind. */
const MIN_POSITION_USD = 0.01;
/** After an incomplete flatten (e.g. a bad quote), wait before the monitor tries again. */
const FLATTEN_RETRY_MS = 60_000;

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
  private lastFlattenAt = Number.NEGATIVE_INFINITY;

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

  /** `internal` marks the exits sent by flatten itself, so they can't trigger another flatten. */
  private async process(intent: OrderIntent, internal = false): Promise<DecisionEvent> {
    const { policy, broker, journal } = this.deps;
    const now = this.now();
    const { tokens, prices } = await this.prices();
    const state = broker.mark(prices, now, policy.swarm);
    // In swarm mode an exit closes the agent's own position, not the pooled one.
    const heldUsd = state.agents ? (state.agents[intent.agentId]?.positionsUsd[intent.asset] ?? 0) : (state.positionsUsd[intent.asset] ?? 0);
    const order: Order = {
      id: this.newId(),
      agentId: intent.agentId,
      side: intent.side,
      asset: intent.asset,
      notionalUsd: intent.closePosition && intent.side === "sell" ? heldUsd : intent.notionalUsd,
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
      await this.tripKillSwitch(`policy:${decision.triggeredRule ?? "max_drawdown"}`, decision.reason, decision.timestamp);
    }

    const event: DecisionEvent = {
      type: "decision",
      ...decision,
      ...(execution ? { execution } : {}),
      equityUsd: broker.equityUsd(prices),
    };
    journal.append(event);
    this.deps.onStateChange?.(broker.state);

    // The drawdown limit was hit: stop the bleeding without waiting for the agent to ask for it.
    if (!internal && policy.autoFlatten && decision.effects.activateKillSwitch) {
      await this.flattenAll("policy:max_drawdown", decision.reason);
    }
    if (!internal) await this.checkAgents(prices, now);
    return event;
  }

  private async tripKillSwitch(by: string, reason: string, timestamp: string): Promise<void> {
    this.deps.broker.setKillSwitch(true);
    const onchain = await this.deps.vault?.tripKillSwitch(reason);
    this.deps.journal.append({
      type: "kill_switch",
      timestamp,
      on: true,
      by,
      reason,
      ...(onchain ? { onchain: this.withLink(onchain) } : {}),
    });
  }

  /**
   * Sells every held position, one reduce-only order each. The orders go through the same gate as any
   * other order, so they are evaluated, logged and bounded by the execution guards (slippage, frequency).
   * In swarm mode each position is sold by its owner; `onlyAgent` limits the unwind to one agent.
   */
  private async flattenAll(by: string, reason: string, onlyAgent?: string): Promise<DecisionEvent[]> {
    const { policy, broker, journal } = this.deps;
    this.lastFlattenAt = this.now();
    const { prices } = await this.prices();
    const state = broker.mark(prices, this.now(), policy.swarm);
    const held = (m: Record<string, number>) => Object.entries(m).filter(([asset, usd]) => asset !== QUOTE_ASSET && usd > MIN_POSITION_USD);
    const targets: { agentId: string; asset: string }[] = state.agents
      ? Object.entries(state.agents)
          .filter(([id]) => !onlyAgent || id === onlyAgent)
          .flatMap(([agentId, a]) => held(a.positionsUsd).map(([asset]) => ({ agentId, asset })))
      : onlyAgent
        ? []
        : held(state.positionsUsd).map(([asset]) => ({ agentId: by, asset }));
    if (targets.length === 0) return [];
    journal.append({
      type: "flatten",
      timestamp: new Date(this.now()).toISOString(),
      by,
      reason,
      positions: targets.map((t) => (state.agents ? `${t.agentId}/${t.asset}` : t.asset)),
    });
    const out: DecisionEvent[] = [];
    for (const t of targets) {
      out.push(await this.process({ agentId: t.agentId, side: "sell", asset: t.asset, notionalUsd: 0, closePosition: true }, true));
    }
    return out;
  }

  /** Sells every position now (operator button). Unlike a kill-switch trip, this does not stop the agent. */
  flatten(by: string, reason: string): Promise<DecisionEvent[]> {
    const run = this.queue.then(() => this.flattenAll(by, reason));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Checks the account against the limits that do not depend on an order. An agent that stops proposing
   * orders must not be able to sit on a drawdown breach unnoticed: call this on a timer.
   */
  monitor(): Promise<void> {
    const run = this.queue.then(() => this.runMonitor());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * No price for something we hold means the feed is down, not that the position is worthless:
   * marking it at zero would fake a crash and sell everything on bad data. Callers skip the round.
   */
  private blind(prices: Record<string, number>): boolean {
    return Object.entries(this.deps.broker.state.holdings).some(
      ([asset, units]) => asset !== QUOTE_ASSET && units > 0 && !((prices[asset] ?? 0) > 0),
    );
  }

  private async runMonitor(): Promise<void> {
    const { policy, broker } = this.deps;
    const now = this.now();
    const { prices } = await this.prices();
    if (this.blind(prices)) return;

    const state = broker.mark(prices, now, policy.swarm);
    const risk = assessRisk(state, policy);
    if (risk.drawdownBreached) {
      const reason = `Drawdown from peak is ${risk.drawdownPct}%, limit is ${policy.maxDrawdownPct}%: kill-switch activated`;
      if (!broker.state.killSwitch) await this.tripKillSwitch("policy:max_drawdown", reason, new Date(now).toISOString());
      if (policy.autoFlatten && now - this.lastFlattenAt >= FLATTEN_RETRY_MS) await this.flattenAll("policy:max_drawdown", reason);
    }
    await this.checkAgents(prices, now);
    this.deps.onStateChange?.(broker.state);
  }

  /**
   * Swarm mode: quarantine every agent that fell too far below its own peak and unwind its positions,
   * while the other agents keep trading. The account-level kill-switch is not touched.
   */
  private async checkAgents(prices: Record<string, number>, now: number): Promise<void> {
    const { policy, broker, journal } = this.deps;
    if (!policy.swarm || this.blind(prices)) return;
    const state = broker.mark(prices, now, policy.swarm);
    for (const a of assessAgents(state, policy)) {
      if (!a.breached || a.quarantined) continue;
      const reason = `Agent ${a.agentId} is ${a.drawdownPct}% below its own peak, limit is ${a.limitPct}%: quarantined`;
      broker.setQuarantine(a.agentId, true);
      journal.append({ type: "agent_quarantine", timestamp: new Date(now).toISOString(), agentId: a.agentId, on: true, reason, drawdownPct: a.drawdownPct });
      if (policy.autoFlatten) await this.flattenAll("policy:agent_drawdown", reason, a.agentId);
    }
    this.deps.onStateChange?.(broker.state);
  }

  /** Operator action: let a quarantined agent trade again. Its own peak is reset so it does not re-trip at once. */
  releaseAgent(agentId: string, by: string, reason: string): Promise<void> {
    const run = this.queue.then(async () => {
      const { broker, journal, policy } = this.deps;
      const { prices } = await this.prices();
      const state = broker.mark(prices, this.now(), policy.swarm);
      const book = broker.state.agents?.[agentId];
      if (!book || !state.agents?.[agentId]) throw new Error(`Unknown agent ${agentId}`);
      broker.setQuarantine(agentId, false);
      book.peakEquityUsd = state.agents[agentId].equityUsd;
      journal.append({ type: "agent_quarantine", timestamp: new Date(this.now()).toISOString(), agentId, on: false, reason: `${reason} (by ${by})` });
      this.deps.onStateChange?.(broker.state);
    });
    this.queue = run.catch(() => undefined);
    return run;
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
      this.deps.broker.apply({ side: order.side, asset: order.asset, ...fill }, now, order.agentId);
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
