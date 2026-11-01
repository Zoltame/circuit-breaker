// Proposes one order through the Circuit Breaker, as an agent would.
// Usage: pnpm propose <buy|sell> <asset> <notionalUsd> [leverage] [--onchain]
// Example: pnpm propose buy wNEAR 500 --onchain

import type { Side } from "@circuit-breaker/policy-engine";
import { buildBreaker } from "./lib/breaker.ts";

const onchain = process.argv.includes("--onchain");
const [side, asset, notional, leverage] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if ((side !== "buy" && side !== "sell") || !asset || !notional) {
  console.error("usage: pnpm propose <buy|sell> <asset> <notionalUsd> [leverage] [--onchain]");
  process.exit(1);
}

const { breaker } = buildBreaker({ onchain });
const ev = await breaker.submit({
  agentId: "cli",
  side: side as Side,
  asset,
  notionalUsd: Number(notional),
  leverage: leverage ? Number(leverage) : 1,
});
console.log(JSON.stringify(ev, null, 2));
