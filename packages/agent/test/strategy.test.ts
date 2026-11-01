import { describe, expect, it } from "vitest";
import { momentum, type MarketView } from "../src/strategy.ts";

const view = (over: Partial<MarketView>): MarketView => ({
  now: 0,
  asset: "wNEAR",
  price: 4,
  history: [],
  cashUsd: 10_000,
  units: 0,
  equityUsd: 10_000,
  ...over,
});

describe("momentum", () => {
  const s = momentum({ lookback: 2, thresholdBps: 10, stepPct: 5 });

  it("waits until it has enough history", () => {
    expect(s(view({ history: [4] }))).toBeNull();
  });

  it("buys 5% of equity on a rise", () => {
    expect(s(view({ history: [3.9, 3.95], price: 4 }))).toEqual({ side: "buy", asset: "wNEAR", notionalUsd: 500 });
  });

  it("sells on a fall only if it holds enough", () => {
    expect(s(view({ history: [4.1, 4.05], price: 4 }))).toBeNull();
    expect(s(view({ history: [4.1, 4.05], price: 4, units: 200 }))).toEqual({
      side: "sell",
      asset: "wNEAR",
      notionalUsd: 500,
    });
  });

  it("does nothing in a flat market", () => {
    expect(s(view({ history: [4, 4], price: 4.0001 }))).toBeNull();
  });
});
