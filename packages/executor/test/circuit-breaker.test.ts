import { parsePolicy, type Policy } from "@circuit-breaker/policy-engine";
import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  MemoryJournal,
  PaperBroker,
  fromBaseUnits,
  toBaseUnits,
  type DryQuote,
  type DryQuoteRequest,
  type Quoter,
  type TokenInfo,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

const WNEAR = "nep141:wrap.near";
const USDC = "nep141:usdc-test";

/** Deterministic quoter: fills at `price` minus `costBps`. */
class FakeQuoter implements Quoter {
  price = 4;
  costBps = 30;
  fail = false;
  /** Simulates the price feed being down (as opposed to the quote endpoint). */
  tokensFail = false;
  quoteCalls = 0;

  async tokens(): Promise<TokenInfo[]> {
    if (this.tokensFail) throw new Error("price feed down");
    return [
      { assetId: WNEAR, decimals: 24, blockchain: "near", symbol: "wNEAR", price: this.price },
      { assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 1 },
    ];
  }

  async dryQuote(req: DryQuoteRequest): Promise<DryQuote> {
    this.quoteCalls++;
    if (this.fail) throw new Error("network down");
    const keep = 1 - this.costBps / 10_000;
    if (req.originAssetId === USDC) {
      const inUsd = fromBaseUnits(req.amount, 6);
      const outUsd = inUsd * keep;
      const amountOut = toBaseUnits(outUsd / this.price, 24);
      return { amountIn: req.amount, amountInUsd: inUsd, amountOut, amountOutUsd: outUsd, minAmountOut: amountOut };
    }
    const inUsd = fromBaseUnits(req.amount, 24) * this.price;
    const outUsd = inUsd * keep;
    const amountOut = toBaseUnits(outUsd, 6);
    return { amountIn: req.amount, amountInUsd: inUsd, amountOut, amountOutUsd: outUsd, minAmountOut: amountOut };
  }
}

const policy: Policy = parsePolicy({
  version: 1,
  allowedAssets: ["wNEAR", "USDC"],
  maxOrderPct: 10,
  maxExposurePct: 30,
  maxLeverage: 1,
  maxDailyLossPct: 5,
  maxDrawdownPct: 15,
  maxOrdersPerHour: 3,
  maxSlippageBps: 100,
});

function setup(over: Partial<Policy> = {}) {
  const quoter = new FakeQuoter();
  const journal = new MemoryJournal();
  const broker = PaperBroker.fresh(10_000, NOW);
  let id = 0;
  let clock = NOW;
  const cb = new CircuitBreaker({
    policy: { ...policy, ...over },
    broker,
    quoter,
    journal,
    now: () => clock,
    newId: () => `id-${++id}`,
  });
  return { cb, quoter, journal, broker, tick: (ms: number) => (clock += ms) };
}

describe("CircuitBreaker", () => {
  it("fills an allowed buy at the quoted amounts and journals it", async () => {
    const { cb, broker, journal } = setup();
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 800 });
    expect(ev.verdict).toBe("allow");
    expect(ev.order.quote).toEqual({ amountInUsd: 800, amountOutUsd: 797.6 });
    expect(ev.execution).toMatchObject({ status: "filled", cashDelta: 800 });
    expect(broker.state.cashUsd).toBeCloseTo(9_200);
    expect(broker.state.holdings.wNEAR).toBeCloseTo(199.4); // 797.6 / 4
    expect(journal.events).toHaveLength(1);
  });

  it("blocks a non-whitelisted asset without asking for a quote", async () => {
    const { cb, quoter, broker } = setup();
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "SCAM", notionalUsd: 100 });
    expect(ev).toMatchObject({ verdict: "block", triggeredRule: "asset_whitelist" });
    expect(ev.execution).toBeUndefined();
    expect(quoter.quoteCalls).toBe(0);
    expect(broker.state.cashUsd).toBe(10_000);
  });

  it("fails closed when the quote service is down", async () => {
    const { cb, quoter, broker } = setup();
    quoter.fail = true;
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 100 });
    expect(ev).toMatchObject({ verdict: "block", triggeredRule: "max_slippage", observed: null });
    expect(broker.state.cashUsd).toBe(10_000);
  });

  it("blocks an expensive quote on slippage", async () => {
    const { cb, quoter } = setup();
    quoter.costBps = 250;
    const ev = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 100 });
    expect(ev).toMatchObject({ verdict: "block", triggeredRule: "max_slippage", observed: 250 });
  });

  it("stops a runaway loop on order frequency", async () => {
    const { cb, tick } = setup();
    const verdicts: string[] = [];
    for (let i = 0; i < 5; i++) {
      verdicts.push((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 100 })).verdict);
      tick(1_000);
    }
    expect(verdicts).toEqual(["allow", "allow", "allow", "block", "block"]);
  });

  it("activates the kill-switch on drawdown and blocks new risk after", async () => {
    // autoFlatten is off here: this test is about the gate itself. Auto-flatten has its own tests below.
    const open = { maxExposurePct: 100, maxOrderPct: 100, autoFlatten: false };
    const { cb, quoter, journal, broker } = setup(open);
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    quoter.price = 2; // wNEAR halves: equity ~ 2_000 + 3_988 -> ~40% drawdown
    const hit = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 100 });
    expect(hit).toMatchObject({ verdict: "block", triggeredRule: "daily_loss" }); // rule 6 comes before 7
    // Next UTC day: daily loss resets, drawdown from peak remains -> kill-switch
    const nextDay = setup(open);
    await nextDay.cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    nextDay.quoter.price = 2;
    nextDay.tick(24 * 3_600_000);
    const dd = await nextDay.cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 });
    expect(dd).toMatchObject({ verdict: "block", triggeredRule: "max_drawdown" });
    expect(nextDay.broker.state.killSwitch).toBe(true);
    expect(nextDay.journal.events.some((e) => e.type === "kill_switch" && e.on)).toBe(true);
    const after = await nextDay.cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 });
    expect(after.triggeredRule).toBe("kill_switch");
    expect(broker.state.killSwitch).toBe(false);
    expect(journal.events).toHaveLength(2);
  });

  it("honours a manual kill-switch and its release", async () => {
    const { cb, journal } = setup();
    await cb.setKillSwitch(true, "operator", "manual stop");
    expect((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 })).triggeredRule).toBe(
      "kill_switch",
    );
    await cb.setKillSwitch(false, "operator", "resume");
    expect((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 })).verdict).toBe("allow");
    expect(journal.events.filter((e) => e.type === "kill_switch")).toHaveLength(2);
  });

  it("serialises concurrent submissions", async () => {
    const { cb } = setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 100 })),
    );
    expect(results.map((r) => r.verdict)).toEqual(["allow", "allow", "allow", "block", "block"]);
  });
});

const kinds = (events: { type: string }[]) => events.map((e) => e.type);

describe("reduce-only exits and auto-flatten", () => {
  const open = { maxExposurePct: 100, maxOrderPct: 100, maxOrdersPerHour: 50 };
  const DAY = 24 * 3_600_000;

  /** Buys 8,000 of wNEAR, halves the price, moves to the next UTC day: ~40% drawdown, daily loss reset. */
  async function crashed(over: Partial<Policy> = {}) {
    const ctx = setup({ ...open, ...over });
    await ctx.cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    ctx.quoter.price = 2;
    ctx.tick(DAY);
    return ctx;
  }

  it("lets the operator flatten after a loop used up the frequency limit, but not the agent's own sell", async () => {
    const { cb, broker } = setup({ ...open, maxOrdersPerHour: 2, autoFlatten: false });
    for (let i = 0; i < 2; i++) await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 1_000 });

    const own = await cb.submit({ agentId: "a", side: "sell", asset: "wNEAR", notionalUsd: 100 });
    expect(own).toMatchObject({ verdict: "block", triggeredRule: "order_frequency" });

    const [exit] = await cb.flatten("operator", "get out");
    expect(exit).toMatchObject({ verdict: "allow", waived: ["order_frequency"] });
    expect(broker.state.holdings.wNEAR).toBe(0);
    expect(broker.state.killSwitch).toBe(false);
  });

  it("lets the agent sell its position while the kill-switch is on", async () => {
    const { cb, broker } = setup({ ...open, autoFlatten: false });
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 4_000 });
    await cb.setKillSwitch(true, "operator", "stop");
    expect((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 })).triggeredRule).toBe("kill_switch");

    const exit = await cb.submit({ agentId: "a", side: "sell", asset: "wNEAR", notionalUsd: 0, closePosition: true });
    expect(exit.verdict).toBe("allow");
    expect(exit.waived).toEqual(["kill_switch"]);
    expect(exit.order.notionalUsd).toBeCloseTo(3_988); // 997 units at $4, taken from the same marking
    expect(exit.execution).toMatchObject({ status: "filled" });
    expect(broker.state.holdings.wNEAR).toBe(0); // exactly zero, no float dust
    expect(broker.state.cashUsd).toBeCloseTo(6_000 + 3_988 * 0.997);
    expect(broker.state.killSwitch).toBe(true); // exiting does not release anything
  });

  it("auto-flattens when the drawdown limit trips the kill-switch", async () => {
    const { cb, broker, journal } = await crashed();
    const dd = await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 });
    expect(dd).toMatchObject({ verdict: "block", triggeredRule: "max_drawdown" });

    expect(broker.state.killSwitch).toBe(true);
    expect(broker.state.holdings.wNEAR).toBe(0);
    expect(kinds(journal.events)).toEqual(["decision", "kill_switch", "decision", "flatten", "decision"]);
    const exit = journal.events[4];
    expect(exit).toMatchObject({ type: "decision", verdict: "allow", order: { side: "sell", agentId: "policy:max_drawdown" } });
    expect((exit as { waived: string[] }).waived).toContain("max_drawdown");
    expect(journal.events.filter((e) => e.type === "flatten")).toHaveLength(1); // no recursion
  });

  it("does not flatten when autoFlatten is off", async () => {
    const { cb, broker, journal } = await crashed({ autoFlatten: false });
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 });
    expect(broker.state.killSwitch).toBe(true);
    expect(broker.state.holdings.wNEAR).toBeGreaterThan(0);
    expect(kinds(journal.events)).not.toContain("flatten");
  });

  it("monitor trips the kill-switch and flattens with no order proposed", async () => {
    const { cb, broker, journal } = await crashed();
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(true);
    expect(broker.state.holdings.wNEAR).toBe(0);
    expect(kinds(journal.events)).toEqual(["decision", "kill_switch", "flatten", "decision"]);
    expect(journal.events[1]).toMatchObject({ type: "kill_switch", on: true, by: "policy:max_drawdown" });
  });

  it("monitor retries a failed flatten, but not in a tight loop", async () => {
    const { cb, quoter, broker, journal, tick } = await crashed();
    quoter.fail = true; // exits can't be quoted
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(true);
    expect(broker.state.holdings.wNEAR).toBeGreaterThan(0);
    const flattens = () => journal.events.filter((e) => e.type === "flatten").length;
    expect(flattens()).toBe(1);

    tick(10_000);
    await cb.monitor(); // too soon
    expect(flattens()).toBe(1);

    quoter.fail = false;
    tick(60_000);
    await cb.monitor();
    expect(flattens()).toBe(2);
    expect(broker.state.holdings.wNEAR).toBe(0);
  });

  it("a manual release resets the drawdown peak, so the monitor does not re-trip on the old loss", async () => {
    const { cb, broker, journal, tick } = await crashed({ autoFlatten: false });
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(true);

    await cb.setKillSwitch(false, "operator", "loss accepted");
    expect(broker.state.peakEquityUsd).toBeCloseTo(broker.equityUsd({ USDC: 1, wNEAR: 2 }));
    tick(10_000);
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(false);
    expect(journal.events.filter((e) => e.type === "kill_switch")).toHaveLength(2); // trip + release, no re-trip
    expect((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 })).verdict).toBe("allow");
  });

  it("a release with no price for a held asset keeps the old peak", async () => {
    const { cb, quoter, broker } = await crashed({ autoFlatten: false });
    await cb.monitor();
    const peak = broker.state.peakEquityUsd;
    quoter.tokensFail = true;
    await cb.setKillSwitch(false, "operator", "resume");
    expect(broker.state.peakEquityUsd).toBe(peak);
  });

  it("monitor does nothing when the price feed is down", async () => {
    const { cb, quoter, broker, journal } = setup(open);
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    quoter.tokensFail = true; // positions would be marked at zero: a fake 80% crash
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(false);
    expect(journal.events).toHaveLength(1);
  });

  it("monitor leaves a healthy account alone", async () => {
    const { cb, broker, journal } = setup(open);
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 1_000 });
    await cb.monitor();
    expect(broker.state.killSwitch).toBe(false);
    expect(journal.events).toHaveLength(1);
  });

  it("flatten sells every position on request without touching the kill-switch", async () => {
    const { cb, broker, journal } = setup(open);
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 2_000 });
    const out = await cb.flatten("operator", "manual flatten");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verdict: "allow", execution: { status: "filled" } });
    expect(broker.state.holdings.wNEAR).toBe(0);
    expect(broker.state.killSwitch).toBe(false);
    expect(kinds(journal.events)).toEqual(["decision", "flatten", "decision"]);
    expect(await cb.flatten("operator", "again")).toEqual([]); // nothing left: no event, no order
  });
});

describe("swarm: several agents under one risk desk", () => {
  const swarm = {
    agents: {
      alpha: { budgetPct: 40, maxDrawdownPct: 10 },
      beta: { budgetPct: 40, maxDrawdownPct: 10 },
    },
  };
  const open = { maxExposurePct: 100, maxOrderPct: 100, maxOrdersPerHour: 50, swarm };
  const buy = (agentId: string, notionalUsd: number) => ({ agentId, side: "buy" as const, asset: "wNEAR", notionalUsd });
  const DAY = 24 * 3_600_000;

  it("refuses unlisted agents and enforces each agent's own budget", async () => {
    const { cb } = setup(open);
    expect(await cb.submit(buy("mallory", 100))).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
    expect((await cb.submit(buy("alpha", 3_000))).verdict).toBe("allow"); // ~30% of the account
    // 2,000 more would put alpha at ~50% of the account, over its 40%, although the account has room.
    expect(await cb.submit(buy("alpha", 2_000))).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
    expect((await cb.submit(buy("beta", 2_000))).verdict).toBe("allow"); // beta's budget is untouched
  });

  it("keeps positions apart: an agent can only sell what it holds", async () => {
    const { cb, broker } = setup(open);
    await cb.submit(buy("alpha", 2_000));
    const stolen = await cb.submit({ agentId: "beta", side: "sell", asset: "wNEAR", notionalUsd: 100 });
    expect(stolen).toMatchObject({ verdict: "block", triggeredRule: "agent_budget" });
    const own = await cb.submit({ agentId: "alpha", side: "sell", asset: "wNEAR", notionalUsd: 0, closePosition: true });
    expect(own.verdict).toBe("allow");
    expect(broker.state.agents?.alpha?.positions.wNEAR).toBeUndefined();
  });

  it("quarantines only the agent that lost too much, and unwinds just its positions", async () => {
    const { cb, quoter, broker, journal } = setup(open);
    await cb.submit(buy("alpha", 4_000));
    await cb.submit(buy("beta", 1_000));
    quoter.price = 3.2; // -20%: alpha loses ~20% of its 4,000; beta ~5% of its 4,000; the account ~10%

    await cb.monitor();

    expect(broker.state.agents?.alpha?.quarantined).toBe(true);
    expect(broker.state.agents?.beta?.quarantined).toBe(false);
    expect(broker.state.agents?.alpha?.positions.wNEAR).toBeUndefined(); // unwound
    expect(broker.state.agents?.beta?.positions.wNEAR?.units).toBeCloseTo(249.25); // untouched
    expect(broker.state.killSwitch).toBe(false); // the account as a whole is within its limits
    expect(broker.state.agents?.alpha?.realizedUsd).toBeCloseTo(997 * 3.2 * 0.997 - 4_000, 0);

    const kinds_ = kinds(journal.events);
    expect(kinds_).toContain("agent_quarantine");
    expect(journal.events.find((e) => e.type === "flatten")).toMatchObject({ positions: ["alpha/wNEAR"] });
    const exit = journal.events.filter((e) => e.type === "decision").at(-1);
    expect(exit).toMatchObject({ verdict: "allow", order: { agentId: "alpha", side: "sell" } });
    expect((exit as { waived: string[] }).waived).toContain("agent_quarantine");
  });

  it("keeps the quarantined agent out while the others carry on", async () => {
    const { cb, quoter, tick } = setup(open);
    await cb.submit(buy("alpha", 4_000));
    await cb.submit(buy("beta", 1_000));
    quoter.price = 3.2;
    await cb.monitor();
    tick(DAY); // the account's daily loss resets; alpha's quarantine does not

    expect(await cb.submit(buy("alpha", 100))).toMatchObject({ verdict: "block", triggeredRule: "agent_quarantine" });
    expect((await cb.submit(buy("beta", 500))).verdict).toBe("allow");
  });

  it("lets the operator release a quarantined agent", async () => {
    const { cb, quoter, tick, journal } = setup(open);
    await cb.submit(buy("alpha", 4_000));
    quoter.price = 3.2;
    await cb.monitor();
    tick(DAY);
    await cb.releaseAgent("alpha", "operator", "reviewed");

    expect(journal.events.at(-1)).toMatchObject({ type: "agent_quarantine", agentId: "alpha", on: false });
    expect((await cb.submit(buy("alpha", 500))).verdict).toBe("allow");
    await cb.monitor(); // its peak was reset: the release does not re-trip on the old loss
    expect(journal.events.filter((e) => e.type === "agent_quarantine" && e.on)).toHaveLength(1);
    await expect(cb.releaseAgent("ghost", "operator", "x")).rejects.toThrow("Unknown agent");
  });

  it("flatten sells each position through its owner", async () => {
    const { cb, broker, journal } = setup(open);
    await cb.submit(buy("alpha", 2_000));
    await cb.submit(buy("beta", 1_000));
    const out = await cb.flatten("operator", "manual");
    expect(out.map((e) => e.order.agentId)).toEqual(["alpha", "beta"]);
    expect(out.every((e) => e.verdict === "allow" && e.execution?.status === "filled")).toBe(true);
    expect(journal.events.find((e) => e.type === "flatten")).toMatchObject({ positions: ["alpha/wNEAR", "beta/wNEAR"] });
    expect(broker.state.holdings.wNEAR).toBe(0);
  });

  it("a pooled account keeps no per-agent books", async () => {
    const { cb, broker } = setup();
    await cb.submit(buy("anyone", 500));
    expect(broker.state.agents).toBeUndefined();
  });
});

describe("unit conversion", () => {
  it("converts to base units without float drift", () => {
    expect(toBaseUnits(1, 24)).toBe(10n ** 24n);
    expect(toBaseUnits(800, 6)).toBe(800_000_000n);
    expect(toBaseUnits(0.1, 6)).toBe(100_000n);
  });
});
