// Shared types for the policy engine. All money values are USD, all times are epoch ms (UTC).

export type Side = "buy" | "sell";

export interface Quote {
  /** USD value of what the agent pays (1Click `amountInUsd`). */
  amountInUsd: number;
  /** USD value of what the agent receives (1Click `amountOutUsd`). */
  amountOutUsd: number;
}

export interface Order {
  id: string;
  agentId: string;
  side: Side;
  /** Asset being bought or sold, e.g. "wNEAR". The quote currency is USD(C). */
  asset: string;
  /** Order size in USD, before leverage. */
  notionalUsd: number;
  /** 1 for spot. */
  leverage: number;
  /** Execution quote. A missing quote fails closed on the slippage rule. */
  quote?: Quote;
}

export interface AccountState {
  equityUsd: number;
  /** Highest equity ever observed (for total drawdown). */
  peakEquityUsd: number;
  /** Equity at the start of the current UTC day (for daily loss). */
  dayStartEquityUsd: number;
  /** Current USD exposure per asset. */
  positionsUsd: Record<string, number>;
  /** Timestamps of previously allowed orders (for frequency). */
  recentOrderTimes: number[];
  /** Persistent kill-switch, e.g. set after a drawdown breach or by the operator. */
  killSwitch: boolean;
  /**
   * Per-agent view. Present only in swarm mode (policy.swarm set): then every position belongs to exactly
   * one agent, and an agent can only sell what it holds itself. Absent = one pooled account.
   */
  agents?: Record<string, AgentState>;
}

export interface AgentState {
  /** Gross USD value of the agent's open positions. */
  exposureUsd: number;
  /** The agent's own equity: its allocation plus its realised and unrealised PnL. */
  equityUsd: number;
  /** Highest value of `equityUsd` seen (for the agent's own drawdown). */
  peakEquityUsd: number;
  /** Set once the agent hit its drawdown limit: it can only exit until an operator releases it. */
  quarantined: boolean;
  positionsUsd: Record<string, number>;
}

export type RuleId =
  | "kill_switch"
  | "asset_whitelist"
  | "max_order_size"
  | "max_exposure"
  | "max_leverage"
  | "daily_loss"
  | "max_drawdown"
  | "agent_quarantine"
  | "agent_budget"
  | "order_frequency"
  | "max_slippage"
  | "trading_hours";

export type Verdict = "allow" | "block";

export interface Decision {
  id: string;
  /** ISO 8601, UTC. */
  timestamp: string;
  order: Order;
  verdict: Verdict;
  /** Rule that blocked the order, null when allowed. */
  triggeredRule: RuleId | null;
  /** Human-readable reason, suitable for the dashboard and the log. */
  reason: string;
  /** Value measured by the triggering rule (null when allowed or not measurable). */
  observed: number | string | boolean | null;
  /** Limit of the triggering rule. */
  limit: number | string | boolean | null;
  /**
   * Rules that were in breach but waived because the order only reduces risk (reduce-only mode).
   * Empty for ordinary decisions. Recorded so the audit trail shows exactly what was bypassed and why.
   */
  waived: RuleId[];
  /** Side effects the caller must apply. The engine itself never mutates anything. */
  effects: { activateKillSwitch: boolean };
}

/** One agent's own drawdown against its own limit (swarm mode). */
export interface AgentAssessment {
  agentId: string;
  drawdownPct: number;
  limitPct: number;
  breached: boolean;
  quarantined: boolean;
}

/** Account-level risk figures, computed without any order. Shared by the rules and by the monitor. */
export interface RiskAssessment {
  /** Drop from the highest equity seen, %. */
  drawdownPct: number;
  /** Loss since the UTC day start, % (negative when up). */
  dailyLossPct: number;
  /** Drawdown limit reached: the kill-switch must be on and positions should be unwound. */
  drawdownBreached: boolean;
  /** Daily loss limit reached: new risk is blocked until the UTC day resets. */
  dailyLossBreached: boolean;
}
