import { describe, expect, it } from "vitest";
import type { DryQuote, DryQuoteRequest, Quoter, TokenInfo } from "../src/oneclick.ts";
import { ShockQuoter } from "../src/shock.ts";

const USDC: TokenInfo = { assetId: "usdc", decimals: 6, blockchain: "near", symbol: "USDC", price: 1 };
const WNEAR: TokenInfo = { assetId: "wnear", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4 };

/** 1:1 at list price, no fee: 100 USDC <-> 25 wNEAR. */
const flat: Quoter = {
  tokens: async () => [USDC, WNEAR],
  dryQuote: async (req: DryQuoteRequest): Promise<DryQuote> => {
    const buy = req.originAssetId === "usdc";
    const inUsd = buy ? Number(req.amount) / 1e6 : (Number(req.amount) / 1e24) * 4;
    const out = buy ? BigInt(Math.round((inUsd / 4) * 1e24)) : BigInt(Math.round(inUsd * 1e6));
    return { amountIn: req.amount, amountInUsd: inUsd, amountOut: out, amountOutUsd: inUsd, minAmountOut: out };
  },
};

describe("ShockQuoter", () => {
  it("passes everything through when no shock is set", async () => {
    const m = new ShockQuoter(flat);
    expect(await m.tokens()).toEqual([USDC, WNEAR]);
    const q = await m.dryQuote({ originAssetId: "usdc", destinationAssetId: "wnear", amount: 100_000_000n, slippageBps: 100 });
    expect(Number(q.amountOut) / 1e24).toBeCloseTo(25);
  });

  it("scales the shocked asset's price and both directions of its quotes", async () => {
    const m = new ShockQuoter(flat);
    m.setShock("wNEAR", 0.4); // -60%
    expect((await m.tokens()).find((t) => t.symbol === "wNEAR")?.price).toBeCloseTo(1.6);

    const buy = await m.dryQuote({ originAssetId: "usdc", destinationAssetId: "wnear", amount: 100_000_000n, slippageBps: 100 });
    expect(Number(buy.amountOut) / 1e24).toBeCloseTo(62.5); // $100 buys 2.5x more units
    expect(buy.amountOutUsd).toBeCloseTo(100);

    const sell = await m.dryQuote({ originAssetId: "wnear", destinationAssetId: "usdc", amount: 25n * 10n ** 24n, slippageBps: 100 });
    expect(Number(sell.amountOut) / 1e6).toBeCloseTo(40); // 25 units now fetch $40, not $100
    expect(sell.amountInUsd).toBeCloseTo(40);

    m.clear();
    expect((await m.tokens()).find((t) => t.symbol === "wNEAR")?.price).toBe(4);
  });
});
