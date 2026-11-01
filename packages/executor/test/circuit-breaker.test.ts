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
  quoteCalls = 0;

  async tokens(): Promise<TokenInfo[]> {
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

  it("activates the kill-switch on drawdown and blocks everything after", async () => {
    const { cb, quoter, journal, broker } = setup({ maxExposurePct: 100, maxOrderPct: 100 });
    await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    quoter.price = 2; // wNEAR halves: equity ~ 2_000 + 3_988 -> ~40% drawdown
    const hit = await cb.submit({ agentId: "a", side: "sell", asset: "wNEAR", notionalUsd: 100 });
    expect(hit).toMatchObject({ verdict: "block", triggeredRule: "daily_loss" }); // rule 6 comes before 7
    // Next UTC day: daily loss resets, drawdown from peak remains -> kill-switch
    const nextDay = setup({ maxExposurePct: 100, maxOrderPct: 100 });
    await nextDay.cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 8_000 });
    nextDay.quoter.price = 2;
    nextDay.tick(24 * 3_600_000);
    const dd = await nextDay.cb.submit({ agentId: "a", side: "sell", asset: "wNEAR", notionalUsd: 100 });
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
    cb.setKillSwitch(true, "operator", "manual stop");
    expect((await cb.submit({ agentId: "a", side: "buy", asset: "wNEAR", notionalUsd: 10 })).triggeredRule).toBe(
      "kill_switch",
    );
    cb.setKillSwitch(false, "operator", "resume");
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

describe("unit conversion", () => {
  it("converts to base units without float drift", () => {
    expect(toBaseUnits(1, 24)).toBe(10n ** 24n);
    expect(toBaseUnits(800, 6)).toBe(800_000_000n);
    expect(toBaseUnits(0.1, 6)).toBe(100_000n);
  });
});
