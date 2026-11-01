import { describe, expect, it } from "vitest";
import { evaluateOrder } from "../src/evaluate.ts";
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
