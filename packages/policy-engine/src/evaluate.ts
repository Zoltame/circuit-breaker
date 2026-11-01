import { DAYS, type Policy } from "./policy.ts";
import type { AccountState, Decision, Order, RuleId } from "./types.ts";

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
  const loss = pctOf(state.dayStartEquityUsd - state.equityUsd, state.dayStartEquityUsd);
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
  const dd = pctOf(state.peakEquityUsd - state.equityUsd, state.peakEquityUsd);
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
  ["asset_whitelist", assetWhitelist],
  ["max_order_size", maxOrderSize],
  ["max_exposure", maxExposure],
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
  for (const [, check] of RULES) {
    const breach = check(input);
    if (breach) {
      return {
        ...base,
        verdict: "block",
        triggeredRule: breach.rule,
        reason: breach.reason,
        observed: breach.observed,
        limit: breach.limit,
        effects: { activateKillSwitch: breach.activateKillSwitch ?? false },
      };
    }
  }
  return {
    ...base,
    verdict: "allow",
    triggeredRule: null,
    reason: "All rules passed",
    observed: null,
    limit: null,
    effects: { activateKillSwitch: false },
  };
}
