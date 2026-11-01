// J1 spike: prove we can get real NEAR Intents prices without moving funds.
// GET /v0/tokens, then POST /v0/quote with dry: true (no deposit address is created).
// Field names come from https://1click.chaindefuser.com/docs/v0/openapi.yaml

const BASE = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com";
const JWT = process.env.ONECLICK_JWT;

interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  priceUpdatedAt?: string;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (JWT) h["X-API-Key"] = JWT;
  return h;
}

async function main(): Promise<void> {
  const tokensRes = await fetch(`${BASE}/v0/tokens`);
  if (!tokensRes.ok) throw new Error(`/v0/tokens -> HTTP ${tokensRes.status}`);
  const tokens = (await tokensRes.json()) as Token[];
  console.log(`tokens: ${tokens.length} supported`);

  const onNear = (sym: string) =>
    tokens.find((t) => t.blockchain === "near" && t.symbol.toUpperCase() === sym);
  const from = onNear("WNEAR");
  const to = onNear("USDC");
  if (!from || !to) throw new Error("wNEAR or USDC on NEAR not found in token list");
  console.log(`from: ${from.assetId} (${from.decimals} dec, $${from.price})`);
  console.log(`to:   ${to.assetId} (${to.decimals} dec, $${to.price})`);

  // Funds would live inside intents.near, so origin/refund/recipient are all INTENTS.
  // Dry run: the account is only used for routing metadata, nothing is signed or sent.
  const account = process.env.DRY_QUOTE_ACCOUNT ?? "intents.near";
  const amount = (10n ** BigInt(from.decimals)).toString(); // 1 wNEAR in base units
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 50, // bps
    originAsset: from.assetId,
    depositType: "INTENTS",
    destinationAsset: to.assetId,
    amount,
    refundTo: account,
    refundType: "INTENTS",
    recipient: account,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };

  const t0 = Date.now();
  const quoteRes = await fetch(`${BASE}/v0/quote`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await quoteRes.text();
  console.log(`\nPOST /v0/quote -> HTTP ${quoteRes.status} in ${Date.now() - t0} ms (auth: ${JWT ? "partner JWT" : "none"})`);
  if (!quoteRes.ok) {
    console.log(text);
    process.exit(1);
  }
  const { quote } = JSON.parse(text) as { quote: Record<string, unknown> };
  for (const k of ["amountIn", "amountInUsd", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut", "timeEstimate"]) {
    console.log(`  ${k.padEnd(20)} ${String(quote[k])}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
