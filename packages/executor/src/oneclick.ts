// Minimal NEAR Intents 1Click client: token list + dry quotes only (no deposit address, no funds moved).
// Field names: https://1click.chaindefuser.com/docs/v0/openapi.yaml

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
}

export interface DryQuote {
  amountIn: bigint;
  amountInUsd: number;
  amountOut: bigint;
  amountOutUsd: number;
  minAmountOut: bigint;
}

export interface DryQuoteRequest {
  originAssetId: string;
  destinationAssetId: string;
  /** Exact input, in base units of the origin asset. */
  amount: bigint;
  slippageBps: number;
}

export interface Quoter {
  tokens(): Promise<TokenInfo[]>;
  dryQuote(req: DryQuoteRequest): Promise<DryQuote>;
}

export interface OneClickOptions {
  baseUrl?: string;
  /** Partner JWT, sent as X-API-Key. Optional: without it 1Click adds a platform fee. */
  jwt?: string | undefined;
  /** Account used as routing metadata in dry quotes. Nothing is signed or sent to it. */
  account?: string;
  tokenCacheMs?: number;
  fetch?: typeof fetch;
}

export class OneClickClient implements Quoter {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private cache: { at: number; tokens: TokenInfo[] } | null = null;

  constructor(private readonly opts: OneClickOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://1click.chaindefuser.com";
    this.fetchFn = opts.fetch ?? fetch;
  }

  async tokens(): Promise<TokenInfo[]> {
    const ttl = this.opts.tokenCacheMs ?? 30_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.tokens;
    const res = await this.fetchFn(`${this.baseUrl}/v0/tokens`);
    if (!res.ok) throw new Error(`1Click /v0/tokens -> HTTP ${res.status}`);
    const raw = (await res.json()) as Array<TokenInfo & { price?: number | string }>;
    const tokens = raw.map((t) => ({ ...t, price: t.price === undefined ? undefined : Number(t.price) })) as TokenInfo[];
    this.cache = { at: Date.now(), tokens };
    return tokens;
  }

  async dryQuote(req: DryQuoteRequest): Promise<DryQuote> {
    const account = this.opts.account ?? "intents.near";
    const body = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageBps,
      originAsset: req.originAssetId,
      depositType: "INTENTS",
      destinationAsset: req.destinationAssetId,
      amount: req.amount.toString(),
      refundTo: account,
      refundType: "INTENTS",
      recipient: account,
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.jwt) headers["X-API-Key"] = this.opts.jwt;
    const res = await this.fetchFn(`${this.baseUrl}/v0/quote`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`1Click /v0/quote -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    const { quote } = JSON.parse(text) as {
      quote: { amountIn: string; amountInUsd: string; amountOut: string; amountOutUsd: string; minAmountOut: string };
    };
    return {
      amountIn: BigInt(quote.amountIn),
      amountInUsd: Number(quote.amountInUsd),
      amountOut: BigInt(quote.amountOut),
      amountOutUsd: Number(quote.amountOutUsd),
      minAmountOut: BigInt(quote.minAmountOut),
    };
  }
}

/** Finds a NEAR-chain token by symbol (case-insensitive). */
export function findNearToken(tokens: TokenInfo[], symbol: string): TokenInfo | undefined {
  const s = symbol.toLowerCase();
  return tokens.find((t) => t.blockchain === "near" && t.symbol.toLowerCase() === s);
}

/** Converts a human amount to base units without float rounding surprises on large decimals. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  const [whole = "0", frac = ""] = amount.toFixed(Math.min(decimals, 18)).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
