// Demo-only price shock. Wraps the real quoter and scales one asset's price (and every quote that buys or
// sells it) by a factor, e.g. 0.4 for a -60% flash crash. Prices and quotes stay real 1Click data otherwise.
// With no shock set it is a pure pass-through.

import type { DryQuote, DryQuoteRequest, Quoter, TokenInfo } from "./oneclick.ts";

export class ShockQuoter implements Quoter {
  private readonly factors = new Map<string, number>();

  constructor(private readonly inner: Quoter) {}

  /** `factor` multiplies the USD price of `symbol` (0.4 = -60%). 1 or undefined clears it. */
  setShock(symbol: string, factor?: number): void {
    if (factor === undefined || factor === 1) this.factors.delete(symbol.toLowerCase());
    else if (factor > 0) this.factors.set(symbol.toLowerCase(), factor);
    else throw new Error("shock factor must be > 0");
  }

  clear(): void {
    this.factors.clear();
  }

  get shocks(): Record<string, number> {
    return Object.fromEntries(this.factors);
  }

  private factorOf(t: TokenInfo | undefined): number {
    return t ? (this.factors.get(t.symbol.toLowerCase()) ?? 1) : 1;
  }

  async tokens(): Promise<TokenInfo[]> {
    const tokens = await this.inner.tokens();
    if (this.factors.size === 0) return tokens;
    return tokens.map((t) => {
      const f = this.factorOf(t);
      return f === 1 || t.price === undefined ? t : { ...t, price: t.price * f };
    });
  }

  async dryQuote(req: DryQuoteRequest): Promise<DryQuote> {
    const q = await this.inner.dryQuote(req);
    if (this.factors.size === 0) return q;
    const tokens = await this.inner.tokens();
    const fin = this.factorOf(tokens.find((t) => t.assetId === req.originAssetId));
    const fout = this.factorOf(tokens.find((t) => t.assetId === req.destinationAssetId));
    if (fin === 1 && fout === 1) return q;
    // Selling a crashed asset yields fin times less; buying it yields 1/fout times more units for the same cash.
    const ratio = fin / fout;
    const scale = (x: bigint) => BigInt(Math.floor(Number(x) * ratio));
    return {
      amountIn: q.amountIn,
      amountInUsd: q.amountInUsd * fin,
      amountOut: scale(q.amountOut),
      amountOutUsd: q.amountOutUsd * fin,
      minAmountOut: scale(q.minAmountOut),
    };
  }
}
