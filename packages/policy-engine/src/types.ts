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
}

export type RuleId =
  | "kill_switch"
  | "asset_whitelist"
  | "max_order_size"
  | "max_exposure"
  | "max_leverage"
  | "daily_loss"
  | "max_drawdown"
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
  /** Side effects the caller must apply. The engine itself never mutates anything. */
  effects: { activateKillSwitch: boolean };
}
