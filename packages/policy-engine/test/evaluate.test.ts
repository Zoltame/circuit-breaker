import { describe, expect, it } from "vitest";
import { assessAgents, assessRisk, evaluateOrder, isReducing } from "../src/evaluate.ts";
import { parsePolicy, type Policy } from "../src/policy.ts";
import type { AccountState, Order } from "../src/types.ts";

// Wednesday 2026-11-04 12:00:00 UTC
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const HOUR = 3_600_000;

const basePolicy: Policy = parsePolicy({
  version: 1,
  killSwitch: false,
  allowedAssets: ["wNEAR", "USDC", "ETH"],
  maxOrderPct: 10,
  maxExposurePct: 30,
  maxLeverage: 2,
  maxDailyLossPct: 5,
  maxDrawdownPct: 15,
  maxOrdersPerHour: 5,
  maxSlippageBps: 100,
  tradingWindowsUtc: [{ start: "08:00", end: "20:00" }],
});

const baseState: AccountState = {
  equityUsd: 10_000,
  peakEquityUsd: 10_000,
  dayStartEquityUsd: 10_000,
  positionsUsd: { wNEAR: 1_000 },
  recentOrderTimes: [],
  killSwitch: false,
};

const baseOrder: Order = {
  id: "o-1",
  agentId: "agent-1",
  side: "buy",
  asset: "wNEAR",
  notionalUsd: 500, // 5% of equity
  leverage: 1,
  quote: { amountInUsd: 500, amountOutUsd: 498 }, // 40 bps
};

function run(over: { order?: Partial<Order>; state?: Partial<AccountState>; policy?: Partial<Policy>; now?: number } = {}) {
  return evaluateOrder({
    order: { ...baseOrder, ...over.order },
    state: { ...baseState, ...over.state },
    policy: { ...basePolicy, ...over.policy },
    now: over.now ?? NOW,
    decisionId: "d-1",
  });
}

describe("baseline", () => {
  it("allows a reasonable order and fills the decision record", () => {
    const d = run();
    expect(d).toMatchObject({
      id: "d-1",
      timestamp: "2026-11-04T12:00:00.000Z",
      verdict: "allow",
      triggeredRule: null,
      observed: null,
      limit: null,
      effects: { activateKillSwitch: false },
    });
    expect(d.order.id).toBe("o-1");
  });

  it("is deterministic and does not mutate its inputs", () => {
    const state = structuredClone(baseState);
    const order = structuredClone(baseOrder);
    const a = evaluateOrder({ order, state, policy: basePolicy, now: NOW, decisionId: "x" });
    const b = evaluateOrder({ order, state, policy: basePolicy, now: NOW, decisionId: "x" });
    expect(a).toEqual(b);
    expect(state).toEqual(baseState);
    expect(order).toEqual(baseOrder);
  });
});

describe("rule 1 — kill-switch", () => {
  it("blocks everything when the policy flag is on", () => {
    expect(run({ policy: { killSwitch: true } })).toMatchObject({ verdict: "block", triggeredRule: "kill_switch" });
  });
  it("blocks everything when the account kill-switch is on", () => {
    expect(run({ state: { killSwitch: true } })).toMatchObject({ verdict: "block", triggeredRule: "kill_switch" });
  });
  it("wins over every other failing rule", () => {
    const d = run({ state: { killSwitch: true }, order: { asset: "SCAM", notionalUsd: 9_999, leverage: 50 } });
    expect(d.triggeredRule).toBe("kill_switch");
  });
});

describe("rule 2 — asset whitelist", () => {
  it("passes a listed asset (case-insensitive)", () => {
    expect(run({ order: { asset: "wnear" } }).verdict).toBe("allow");
  });
  it("blocks an unlisted asset", () => {
    expect(run({ order: { asset: "SCAM" } })).toMatchObject({
      verdict: "block",
      triggeredRule: "asset_whitelist",
      observed: "SCAM",
    });
  });
});

describe("rule 3 — max order size", () => {
  it("passes at exactly the limit", () => {
    expect(run({ order: { notionalUsd: 1_000, quote: { amountInUsd: 1_000, amountOutUsd: 995 } } }).verdict).toBe("allow");
  });
  it("blocks above the limit", () => {
    expect(run({ order: { notionalUsd: 1_500 } })).toMatchObject({
      verdict: "block",
      triggeredRule: "max_order_size",
      observed: 15,
      limit: 10,
    });
  });
  it("blocks when equity is zero or negative", () => {
    expect(run({ state: { equityUsd: 0 } }).triggeredRule).toBe("max_order_size");
  });
});

describe("rule 4 — max exposure per asset", () => {
  it("passes when the resulting exposure stays under the limit", () => {
    expect(run({ state: { positionsUsd: { wNEAR: 2_400 } } }).verdict).toBe("allow"); // 29%
  });
  it("blocks a buy that pushes exposure over the limit", () => {
    expect(run({ state: { positionsUsd: { wNEAR: 2_800 } } })).toMatchObject({
      verdict: "block",
      triggeredRule: "max_exposure",
      observed: 33,
      limit: 30,
    });
  });
  it("counts leverage in the resulting exposure", () => {
    // 2_000 + 500 * 2 = 3_000 -> 30%: at the limit, allowed
    expect(run({ order: { leverage: 2 }, state: { positionsUsd: { wNEAR: 2_000 } } }).verdict).toBe("allow");
    // 2_100 + 1_000 = 3_100 -> 31%: blocked
    expect(run({ order: { leverage: 2 }, state: { positionsUsd: { wNEAR: 2_100 } } }).triggeredRule).toBe("max_exposure");
  });
  it("never blocks a sell, which reduces exposure", () => {
    expect(run({ order: { side: "sell" }, state: { positionsUsd: { wNEAR: 5_000 } } }).verdict).toBe("allow");
  });
});

describe("rule 5 — max leverage", () => {
  it("passes at the limit", () => {
    expect(run({ order: { leverage: 2 } }).verdict).toBe("allow");
  });
  it("blocks above the limit", () => {
    expect(run({ order: { leverage: 3 } })).toMatchObject({
      verdict: "block",
      triggeredRule: "max_leverage",
      observed: 3,
      limit: 2,
    });
  });
});

describe("rule 6 — daily loss", () => {
  it("passes while the daily loss is under the limit", () => {
    expect(run({ state: { equityUsd: 9_600 } }).verdict).toBe("allow"); // -4%
  });
  it("blocks new orders once the daily loss reaches the limit", () => {
    const d = run({ state: { equityUsd: 9_500 } }); // -5%
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "daily_loss", observed: 5, limit: 5 });
    expect(d.effects.activateKillSwitch).toBe(false);
  });
});

describe("rule 7 — total drawdown", () => {
  it("passes while drawdown from peak is under the limit", () => {
    // peak 12_000, equity 10_500 -> 12.5%; day start 10_500 so no daily loss
    expect(run({ state: { peakEquityUsd: 12_000, equityUsd: 10_500, dayStartEquityUsd: 10_500 } }).verdict).toBe("allow");
  });
  it("blocks and requests the kill-switch at the threshold", () => {
    const d = run({ state: { peakEquityUsd: 12_000, equityUsd: 10_200, dayStartEquityUsd: 10_200 } }); // 15%
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "max_drawdown", observed: 15, limit: 15 });
    expect(d.effects.activateKillSwitch).toBe(true);
  });
});

describe("rule 8 — order frequency", () => {
  it("passes under the hourly limit, ignoring orders older than one hour", () => {
    const times = [NOW - 2 * HOUR, NOW - HOUR, NOW - 50 * 60_000, NOW - 1_000, NOW - 500, NOW - 100];
    expect(run({ state: { recentOrderTimes: times } }).verdict).toBe("allow"); // 4 in the last hour
  });
  it("blocks the order that would exceed the hourly limit", () => {
    const times = [1, 2, 3, 4, 5].map((i) => NOW - i * 1_000);
    expect(run({ state: { recentOrderTimes: times } })).toMatchObject({
      verdict: "block",
      triggeredRule: "order_frequency",
      observed: 6,
      limit: 5,
    });
  });
});

describe("rule 9 — max slippage", () => {
  it("passes when the quote is within tolerance", () => {
    expect(run({ order: { quote: { amountInUsd: 500, amountOutUsd: 495 } } }).verdict).toBe("allow"); // 100 bps
  });
  it("blocks when the quote is worse than tolerated", () => {
    expect(run({ order: { quote: { amountInUsd: 500, amountOutUsd: 490 } } })).toMatchObject({
      verdict: "block",
      triggeredRule: "max_slippage",
      observed: 200,
      limit: 100,
    });
  });
  it("fails closed when there is no quote", () => {
    const { quote: _omit, ...noQuote } = baseOrder;
    const d = evaluateOrder({ order: noQuote, state: baseState, policy: basePolicy, now: NOW, decisionId: "d" });
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "max_slippage", observed: null });
  });
});

describe("rule 10 — trading hours", () => {
  it("passes inside a window", () => {
    expect(run({ now: Date.UTC(2026, 10, 4, 8, 0) }).verdict).toBe("allow");
  });
  it("blocks outside every window", () => {
    expect(run({ now: Date.UTC(2026, 10, 4, 21, 30) })).toMatchObject({
      verdict: "block",
      triggeredRule: "trading_hours",
      observed: "wed 21:30",
    });
  });
  it("treats the end of a window as exclusive", () => {
    expect(run({ now: Date.UTC(2026, 10, 4, 20, 0) }).triggeredRule).toBe("trading_hours");
  });
  it("supports windows that wrap past midnight", () => {
    const policy = { tradingWindowsUtc: [{ start: "22:00", end: "02:00" }] };
    expect(run({ policy, now: Date.UTC(2026, 10, 4, 23, 0) }).verdict).toBe("allow");
    expect(run({ policy, now: Date.UTC(2026, 10, 4, 1, 59) }).verdict).toBe("allow");
    expect(run({ policy, now: Date.UTC(2026, 10, 4, 12, 0) }).triggeredRule).toBe("trading_hours");
  });
  it("restricts windows to the listed days", () => {
    const policy: Partial<Policy> = { tradingWindowsUtc: [{ days: ["mon", "tue"], start: "00:00", end: "23:59" }] };
    expect(run({ policy }).triggeredRule).toBe("trading_hours"); // Wednesday
  });
  it("allows any time when no window is configured", () => {
    expect(run({ policy: { tradingWindowsUtc: [] }, now: Date.UTC(2026, 10, 4, 3, 0) }).verdict).toBe("allow");
  });
});

describe("rule order", () => {
  it("reports the first failing rule in the documented order", () => {
    // fails whitelist (2), size (3) and leverage (5): whitelist wins
    expect(run({ order: { asset: "SCAM", notionalUsd: 5_000, leverage: 10 } }).triggeredRule).toBe("asset_whitelist");
    // fails size (3) and slippage (9): size wins
    expect(run({ order: { notionalUsd: 5_000, quote: { amountInUsd: 5_000, amountOutUsd: 1 } } }).triggeredRule).toBe(
      "max_order_size",
    );
  });
});

describe("reduce-only exits", () => {
  const sell = (notionalUsd: number, over: Partial<Order> = {}): Partial<Order> => ({ side: "sell", notionalUsd, ...over });
  // Equity 8,500 after a 15% drop from the 10,000 peak; the day started at 8,500 so the daily loss is 0.
  const drawdown: Partial<AccountState> = { equityUsd: 8_500, dayStartEquityUsd: 8_500 };

  it("keeps blocking new risk while the kill-switch is on", () => {
    const d = run({ state: { killSwitch: true } });
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "kill_switch", waived: [] });
  });

  it("lets a sell through the kill-switch and records the waiver", () => {
    const d = run({ state: { killSwitch: true }, order: sell(500, { quote: { amountInUsd: 500, amountOutUsd: 499 } }) });
    expect(d.verdict).toBe("allow");
    expect(d.waived).toEqual(["kill_switch"]);
    expect(d.reason).toContain("Reduce-only");
    expect(d.effects.activateKillSwitch).toBe(false);
  });

  it("lets a sell through the daily loss limit while a buy stays blocked", () => {
    const state = { equityUsd: 9_400 }; // −6% on the day, limit 5%
    expect(run({ state })).toMatchObject({ verdict: "block", triggeredRule: "daily_loss" });
    const d = run({ state, order: sell(500) });
    expect(d.verdict).toBe("allow");
    expect(d.waived).toEqual(["daily_loss"]);
  });

  it("allows an exit at the drawdown limit and still trips the kill-switch", () => {
    const buy = run({ state: drawdown });
    expect(buy).toMatchObject({ verdict: "block", triggeredRule: "max_drawdown", effects: { activateKillSwitch: true } });

    const exit = run({ state: drawdown, order: sell(500) });
    expect(exit.verdict).toBe("allow");
    expect(exit.waived).toEqual(["max_drawdown"]);
    expect(exit.effects.activateKillSwitch).toBe(true);
  });

  it("allows closing a whole position even above the order-size cap", () => {
    // 1,000 is 11.8% of an 8,500 account, over the 10% cap, but it only reduces exposure.
    const d = run({ state: { ...drawdown, killSwitch: true }, order: sell(1_000) });
    expect(d.verdict).toBe("allow");
    expect(d.waived).toEqual(["kill_switch", "max_order_size", "max_drawdown"]);
  });

  it("does not treat an oversized sell as an exit", () => {
    // Selling 1,500 of a 1,000 position would be a short: no waiver.
    expect(run({ state: { killSwitch: true }, order: sell(1_500) })).toMatchObject({ verdict: "block", triggeredRule: "kill_switch" });
  });

  it("does not treat a sell of something not held as an exit", () => {
    const d = run({ state: { killSwitch: true }, order: sell(100, { asset: "ETH" }) });
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "kill_switch", waived: [] });
  });

  it("does not treat a leveraged sell as an exit", () => {
    expect(run({ state: { killSwitch: true }, order: sell(500, { leverage: 2 }) })).toMatchObject({
      verdict: "block",
      triggeredRule: "kill_switch",
    });
  });

  it("lets a held asset be sold after it left the whitelist", () => {
    const d = run({ policy: { allowedAssets: ["USDC"] }, order: sell(500) });
    expect(d.verdict).toBe("allow");
    expect(d.waived).toEqual(["asset_whitelist"]);
    // …but the same asset can not be bought.
    expect(run({ policy: { allowedAssets: ["USDC"] } })).toMatchObject({ verdict: "block", triggeredRule: "asset_whitelist" });
  });

  it("still applies the execution guards to exits", () => {
    const state = { killSwitch: true };
    const bad = run({ state, order: sell(500, { quote: { amountInUsd: 500, amountOutUsd: 480 } }) }); // 400 bps
    expect(bad).toMatchObject({ verdict: "block", triggeredRule: "max_slippage", waived: ["kill_switch"] });

    const flood = run({ state, order: sell(500), now: NOW }).verdict; // sanity: passes alone
    expect(flood).toBe("allow");
    const many = run({ state: { ...state, recentOrderTimes: [1, 2, 3, 4, 5].map((i) => NOW - i * 1_000) }, order: sell(500) });
    expect(many).toMatchObject({ verdict: "block", triggeredRule: "order_frequency" });

    const night = run({ state, order: sell(500), now: Date.UTC(2026, 10, 4, 23, 0, 0) });
    expect(night).toMatchObject({ verdict: "block", triggeredRule: "trading_hours" });
  });

  it("keeps the drawdown kill-switch effect even when a later guard blocks the exit", () => {
    const d = run({ state: drawdown, order: sell(500, { quote: { amountInUsd: 500, amountOutUsd: 480 } }) });
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "max_slippage", effects: { activateKillSwitch: true } });
  });

  it("isReducing is pure and only true for a held, unlevered sell within the position", () => {
    const state = structuredClone(baseState);
    const before = JSON.stringify(state);
    expect(isReducing({ ...baseOrder, side: "sell", notionalUsd: 1_000 }, state)).toBe(true);
    expect(isReducing({ ...baseOrder, side: "sell", notionalUsd: 1_000.0001 }, state)).toBe(true); // float tolerance
    expect(isReducing({ ...baseOrder, side: "sell", notionalUsd: 1_001 }, state)).toBe(false);
    expect(isReducing({ ...baseOrder, side: "sell", notionalUsd: 0 }, state)).toBe(false);
    expect(isReducing({ ...baseOrder, side: "buy" }, state)).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("assessRisk", () => {
  it("reports drawdown and daily loss with the same numbers as the rules", () => {
    const a = assessRisk({ ...baseState, equityUsd: 8_400, dayStartEquityUsd: 9_000 }, basePolicy);
    expect(a).toEqual({ drawdownPct: 16, dailyLossPct: 6.6667, drawdownBreached: true, dailyLossBreached: true });
  });

  it("is quiet when the account is healthy", () => {
    expect(assessRisk(baseState, basePolicy)).toMatchObject({ drawdownBreached: false, dailyLossBreached: false });
  });

  it("breaches at exactly the limit, like the rules", () => {
    expect(assessRisk({ ...baseState, equityUsd: 8_500 }, basePolicy).drawdownBreached).toBe(true);
  });
});

describe("swarm: per-agent budgets and quarantine", () => {
  const swarmPolicy: Partial<Policy> = {
    maxOrderPct: 50,
    maxExposurePct: 100,
    swarm: {
      agents: {
        alpha: { budgetPct: 30, maxDrawdownPct: 10 },
        beta: { budgetPct: 20, maxDrawdownPct: 10 },
      },
    },
  };
  // alpha holds $2,000 of wNEAR (20% of the 10,000 account); beta holds nothing.
  const agents: AccountState["agents"] = {
    alpha: { exposureUsd: 2_000, equityUsd: 3_000, peakEquityUsd: 3_000, quarantined: false, positionsUsd: { wNEAR: 2_000 } },
    beta: { exposureUsd: 0, equityUsd: 2_000, peakEquityUsd: 2_000, quarantined: false, positionsUsd: {} },
  };
  const swarm = (order: Partial<Order>, state: Partial<AccountState> = {}) =>
    run({ policy: swarmPolicy, state: { positionsUsd: { wNEAR: 2_000 }, agents, ...state }, order });

  it("refuses an agent that has no budget", () => {
    expect(swarm({ agentId: "mallory" })).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
  });

  it("allows an agent inside its budget", () => {
    expect(swarm({ agentId: "alpha", notionalUsd: 500 }).verdict).toBe("allow"); // 25% of 30%
  });

  it("blocks an agent above its own budget although the account has room", () => {
    const d = swarm({ agentId: "alpha", notionalUsd: 1_500 }); // 35% > 30%
    expect(d).toMatchObject({ verdict: "block", triggeredRule: "agent_budget", observed: 35, limit: 30 });
    // Budgets are per agent: the same $1,500 is 15% of the account for beta, inside its 20%.
    expect(swarm({ agentId: "beta", notionalUsd: 1_500 }).verdict).toBe("allow");
  });

  it("counts leverage in the agent's exposure", () => {
    // $1,000 at 3x is $3,000 of exposure = 30% of the account, above beta's 20% (the budget rule runs before max_leverage).
    expect(swarm({ agentId: "beta", notionalUsd: 1_000, leverage: 3 })).toMatchObject({ triggeredRule: "agent_budget", observed: 30, limit: 20 });
  });

  it("blocks a quarantined agent from buying", () => {
    const quarantined = { ...agents, alpha: { ...agents.alpha!, quarantined: true } };
    expect(swarm({ agentId: "alpha", notionalUsd: 100 }, { agents: quarantined })).toMatchObject({
      verdict: "block",
      triggeredRule: "agent_quarantine",
    });
    // …but the other agents keep trading.
    expect(swarm({ agentId: "beta", notionalUsd: 100 }, { agents: quarantined }).verdict).toBe("allow");
  });

  it("lets a quarantined agent exit its own position, and records the waiver", () => {
    const quarantined = { ...agents, alpha: { ...agents.alpha!, quarantined: true } };
    const d = swarm({ agentId: "alpha", side: "sell", notionalUsd: 2_000 }, { agents: quarantined });
    expect(d.verdict).toBe("allow");
    expect(d.waived).toContain("agent_quarantine");
  });

  it("does not let an agent sell what it does not hold, nor another agent's position", () => {
    // beta sells wNEAR that only alpha holds
    expect(swarm({ agentId: "beta", side: "sell", notionalUsd: 500 })).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
    // alpha sells more than it holds
    expect(swarm({ agentId: "alpha", side: "sell", notionalUsd: 2_500 })).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
    // alpha sells part of its own position
    expect(swarm({ agentId: "alpha", side: "sell", notionalUsd: 1_000 }).verdict).toBe("allow");
  });

  it("isReducing looks at the agent's own position in swarm mode", () => {
    const state: AccountState = { ...baseState, positionsUsd: { wNEAR: 2_000 }, agents };
    expect(isReducing({ ...baseOrder, agentId: "alpha", side: "sell", notionalUsd: 2_000 }, state)).toBe(true);
    expect(isReducing({ ...baseOrder, agentId: "beta", side: "sell", notionalUsd: 100 }, state)).toBe(false);
  });

  it("does nothing outside swarm mode", () => {
    expect(run({ order: { agentId: "anyone" } }).verdict).toBe("allow");
    expect(assessAgents(baseState, basePolicy)).toEqual([]);
  });

  it("assessAgents reports each agent's own drawdown", () => {
    const state: AccountState = {
      ...baseState,
      agents: { ...agents, alpha: { ...agents.alpha!, equityUsd: 2_600 } }, // 3,000 -> 2,600 = 13.3333%
    };
    const out = assessAgents(state, { ...basePolicy, ...swarmPolicy } as Policy);
    expect(out.find((a) => a.agentId === "alpha")).toEqual({ agentId: "alpha", drawdownPct: 13.3333, limitPct: 10, breached: true, quarantined: false });
    expect(out.find((a) => a.agentId === "beta")).toMatchObject({ drawdownPct: 0, breached: false });
  });
});
