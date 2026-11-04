import { DAYS, type Policy } from "./policy.ts";
import type { AccountState, AgentAssessment, Decision, Order, RiskAssessment, RuleId } from "./types.ts";

const HOUR_MS = 3_600_000;

export interface EvaluateInput {
  order: Order;
  state: AccountState;
  policy: Policy;
  /** Evaluation time, epoch ms. Passed in so the function stays pure. */
  now: number;
  decisionId: string;
}

type Value = number | string | boolean | null;

interface Breach {
  rule: RuleId;
  reason: string;
  observed: Value;
  limit: Value;
  activateKillSwitch?: boolean;
}

type Check = (i: EvaluateInput) => Breach | null;

/** Rounds away float noise so observed values read cleanly in logs (e.g. 33, not 33.00000000000001). */
const round = (x: number): number => Math.round(x * 1e4) / 1e4;
const pctOf = (part: number, whole: number): number => (whole > 0 ? round((part / whole) * 100) : Infinity);

const drawdownOf = (s: AccountState): number => pctOf(s.peakEquityUsd - s.equityUsd, s.peakEquityUsd);
const dailyLossOf = (s: AccountState): number => pctOf(s.dayStartEquityUsd - s.equityUsd, s.dayStartEquityUsd);

/**
 * Account-level risk figures, with no order involved. The rules below use the same numbers, so the
 * periodic monitor and the order gate can never disagree about whether a limit is breached.
 */
export function assessRisk(state: AccountState, policy: Policy): RiskAssessment {
  const drawdownPct = drawdownOf(state);
  const dailyLossPct = dailyLossOf(state);
  return {
    drawdownPct,
    dailyLossPct,
    drawdownBreached: drawdownPct >= policy.maxDrawdownPct,
    dailyLossBreached: dailyLossPct >= policy.maxDailyLossPct,
  };
}

/** USD value of the position the order would sell from: the agent's own in swarm mode, else the pooled one. */
const heldBy = (order: Order, state: AccountState): number =>
  state.agents ? (state.agents[order.agentId]?.positionsUsd[order.asset] ?? 0) : (state.positionsUsd[order.asset] ?? 0);

/** Each agent's own drawdown against its own limit. Empty outside swarm mode. */
export function assessAgents(state: AccountState, policy: Policy): AgentAssessment[] {
  if (!policy.swarm || !state.agents) return [];
  const agents = state.agents;
  return Object.entries(policy.swarm.agents).flatMap(([agentId, limit]) => {
    const a = agents[agentId];
    if (!a) return [];
    const drawdownPct = pctOf(a.peakEquityUsd - a.equityUsd, a.peakEquityUsd);
    return [{ agentId, drawdownPct, limitPct: limit.maxDrawdownPct, breached: drawdownPct >= limit.maxDrawdownPct, quarantined: a.quarantined }];
  });
}

/**
 * A reducing order sells part or all of a spot position that is actually held, without leverage.
 * It can only lower exposure, so it must stay possible when the account is in a breach state:
 * a desk that blocks exits after a loss limit has simply locked itself into the losing position.
 */
export function isReducing(order: Order, state: AccountState): boolean {
  if (order.side !== "sell" || order.leverage > 1) return false;
  // In swarm mode an agent can only exit its own position, never another agent's.
  const held = heldBy(order, state);
  return held > 0 && order.notionalUsd > 0 && order.notionalUsd <= held * (1 + 1e-6);
}

/**
 * Rules waived for a reducing order. They guard against taking on new risk (kill-switch, loss limits,
 * order size) or against buying something unknown: a position that is already held can always be exited,
 * even if its asset has since left the whitelist. Execution-quality guards (frequency, slippage,
 * trading hours) still apply.
 */
const WAIVED_WHEN_REDUCING: ReadonlySet<RuleId> = new Set<RuleId>([
  "kill_switch",
  "agent_quarantine",
  "asset_whitelist",
  "max_order_size",
  "daily_loss",
  "max_drawdown",
]);

const killSwitch: Check = ({ policy, state }) =>
  policy.killSwitch || state.killSwitch
    ? {
        rule: "kill_switch",
        reason: policy.killSwitch ? "Kill-switch is active in the policy" : "Kill-switch is active on the account",
        observed: true,
        limit: false,
      }
    : null;

const assetWhitelist: Check = ({ order, policy }) => {
  const listed = policy.allowedAssets.some((a) => a.toLowerCase() === order.asset.toLowerCase());
  return listed
    ? null
    : {
        rule: "asset_whitelist",
        reason: `Asset ${order.asset} is not in the whitelist`,
        observed: order.asset,
        limit: policy.allowedAssets.join(","),
      };
};

const maxOrderSize: Check = ({ order, state, policy }) => {
  const p = pctOf(order.notionalUsd, state.equityUsd);
  return p > policy.maxOrderPct
    ? {
        rule: "max_order_size",
        reason: `Order is ${p}% of equity, limit is ${policy.maxOrderPct}%`,
        observed: Number.isFinite(p) ? p : null,
        limit: policy.maxOrderPct,
      }
    : null;
};

const maxExposure: Check = ({ order, state, policy }) => {
  if (order.side === "sell") return null; // reduces exposure
  const current = state.positionsUsd[order.asset] ?? 0;
  const p = pctOf(current + order.notionalUsd * order.leverage, state.equityUsd);
  return p > policy.maxExposurePct
    ? {
        rule: "max_exposure",
        reason: `Exposure to ${order.asset} would be ${p}% of equity, limit is ${policy.maxExposurePct}%`,
        observed: p,
        limit: policy.maxExposurePct,
      }
    : null;
};

const agentQuarantine: Check = ({ order, state, policy }) =>
  policy.swarm && state.agents?.[order.agentId]?.quarantined
    ? {
        rule: "agent_quarantine",
        reason: `Agent ${order.agentId} is quarantined after hitting its own drawdown limit: exits only`,
        observed: true,
        limit: false,
      }
    : null;

const agentBudget: Check = ({ order, state, policy }) => {
  if (!policy.swarm) return null;
  const limit = policy.swarm.agents[order.agentId];
  if (!limit) {
    return {
      rule: "agent_budget",
      reason: `Agent ${order.agentId} has no risk budget in the swarm policy`,
      observed: order.agentId,
      limit: Object.keys(policy.swarm.agents).join(","),
    };
  }
  if (order.side === "sell") {
    const held = heldBy(order, state);
    return order.notionalUsd > held * (1 + 1e-6)
      ? {
          rule: "agent_budget",
          reason: `Agent ${order.agentId} holds $${round(held)} of ${order.asset} and can only sell what it holds`,
          observed: order.notionalUsd,
          limit: round(held),
        }
      : null;
  }
  const current = state.agents?.[order.agentId]?.exposureUsd ?? 0;
  const p = pctOf(current + order.notionalUsd * order.leverage, state.equityUsd);
  return p > limit.budgetPct
    ? {
        rule: "agent_budget",
        reason: `Agent ${order.agentId} exposure would be ${p}% of equity, its budget is ${limit.budgetPct}%`,
        observed: p,
        limit: limit.budgetPct,
      }
    : null;
};

const maxLeverage: Check = ({ order, policy }) =>
  order.leverage > policy.maxLeverage
    ? {
        rule: "max_leverage",
        reason: `Leverage ${order.leverage}x exceeds ${policy.maxLeverage}x`,
        observed: order.leverage,
        limit: policy.maxLeverage,
      }
    : null;

const dailyLoss: Check = ({ state, policy }) => {
  const loss = dailyLossOf(state);
  return loss >= policy.maxDailyLossPct
    ? {
        rule: "daily_loss",
        reason: `Daily loss is ${loss}%, limit is ${policy.maxDailyLossPct}%: new orders blocked until the UTC day resets`,
        observed: loss,
        limit: policy.maxDailyLossPct,
      }
    : null;
};

const maxDrawdown: Check = ({ state, policy }) => {
  const dd = drawdownOf(state);
  return dd >= policy.maxDrawdownPct
    ? {
        rule: "max_drawdown",
        reason: `Drawdown from peak is ${dd}%, limit is ${policy.maxDrawdownPct}%: kill-switch activated`,
        observed: dd,
        limit: policy.maxDrawdownPct,
        activateKillSwitch: true,
      }
    : null;
};

const orderFrequency: Check = ({ state, policy, now }) => {
  const lastHour = state.recentOrderTimes.filter((t) => t > now - HOUR_MS && t <= now).length;
  return lastHour >= policy.maxOrdersPerHour
    ? {
        rule: "order_frequency",
        reason: `This would be order #${lastHour + 1} in the last hour, limit is ${policy.maxOrdersPerHour}`,
        observed: lastHour + 1,
        limit: policy.maxOrdersPerHour,
      }
    : null;
};

const maxSlippage: Check = ({ order, policy }) => {
  const q = order.quote;
  if (!q || !(q.amountInUsd > 0)) {
    return {
      rule: "max_slippage",
      reason: "No usable execution quote: refusing to trade blind",
      observed: null,
      limit: policy.maxSlippageBps,
    };
  }
  const bps = round(((q.amountInUsd - q.amountOutUsd) / q.amountInUsd) * 10_000);
  return bps > policy.maxSlippageBps
    ? {
        rule: "max_slippage",
        reason: `Quote costs ${bps} bps, limit is ${policy.maxSlippageBps} bps`,
        observed: bps,
        limit: policy.maxSlippageBps,
      }
    : null;
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const tradingHours: Check = ({ policy, now }) => {
  const windows = policy.tradingWindowsUtc;
  if (windows.length === 0) return null;
  const date = new Date(now);
  const day = DAYS[date.getUTCDay()]!;
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const inside = windows.some((w) => {
    if (w.days && !w.days.includes(day)) return false;
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  });
  if (inside) return null;
  const hhmm = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  const allowed = windows.map((w) => `${w.days ? `${w.days.join("/")} ` : ""}${w.start}-${w.end}`).join(", ");
  return {
    rule: "trading_hours",
    reason: `Outside allowed trading windows (UTC): ${allowed}`,
    observed: `${day} ${hhmm}`,
    limit: allowed,
  };
};

/** Evaluated in this order; the first breach blocks the order (spec §4). */
export const RULES: readonly (readonly [RuleId, Check])[] = [
  ["kill_switch", killSwitch],
  ["agent_quarantine", agentQuarantine],
  ["asset_whitelist", assetWhitelist],
  ["max_order_size", maxOrderSize],
  ["max_exposure", maxExposure],
  ["agent_budget", agentBudget],
  ["max_leverage", maxLeverage],
  ["daily_loss", dailyLoss],
  ["max_drawdown", maxDrawdown],
  ["order_frequency", orderFrequency],
  ["max_slippage", maxSlippage],
  ["trading_hours", tradingHours],
];

/** Pure, deterministic evaluation of one proposed order. Never mutates its inputs. */
export function evaluateOrder(input: EvaluateInput): Decision {
  const base = { id: input.decisionId, timestamp: new Date(input.now).toISOString(), order: input.order };
  const reducing = isReducing(input.order, input.state);
  const waived: RuleId[] = [];
  // A drawdown breach must trip the kill-switch even when the order that revealed it is allowed.
  let activateKillSwitch = false;

  for (const [rule, check] of RULES) {
    const breach = check(input);
    if (!breach) continue;
    if (breach.activateKillSwitch) activateKillSwitch = true;
    if (reducing && WAIVED_WHEN_REDUCING.has(rule)) {
      waived.push(rule);
      continue;
    }
    return {
      ...base,
      verdict: "block",
      triggeredRule: breach.rule,
      reason: breach.reason,
      observed: breach.observed,
      limit: breach.limit,
      waived,
      effects: { activateKillSwitch },
    };
  }
  return {
    ...base,
    verdict: "allow",
    triggeredRule: null,
    reason: waived.length > 0 ? `Reduce-only: exit allowed although ${waived.join(", ")} breached` : "All rules passed",
    observed: null,
    limit: null,
    waived,
    effects: { activateKillSwitch },
  };
}
