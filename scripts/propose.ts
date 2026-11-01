// Proposes one order through the Circuit Breaker, as an agent would.
// Usage: pnpm propose <buy|sell> <asset> <notionalUsd> [leverage]
// Example: pnpm propose buy wNEAR 500

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CircuitBreaker, JsonlJournal, OneClickClient, PaperBroker, type PaperState } from "@circuit-breaker/executor";
import { loadPolicyYaml, type Side } from "@circuit-breaker/policy-engine";

const [side, asset, notional, leverage] = process.argv.slice(2);
if ((side !== "buy" && side !== "sell") || !asset || !notional) {
  console.error("usage: pnpm propose <buy|sell> <asset> <notionalUsd> [leverage]");
  process.exit(1);
}

const STATE = "data/state.json";
mkdirSync("data", { recursive: true });
const broker = existsSync(STATE)
  ? new PaperBroker(JSON.parse(readFileSync(STATE, "utf8")) as PaperState)
  : PaperBroker.fresh(10_000, Date.now());

const breaker = new CircuitBreaker({
  policy: loadPolicyYaml(readFileSync(process.env.POLICY_FILE ?? "policies/default.yaml", "utf8")),
  broker,
  quoter: new OneClickClient({ baseUrl: process.env.ONECLICK_BASE_URL, jwt: process.env.ONECLICK_JWT }),
  journal: new JsonlJournal("data/decisions.jsonl"),
  onStateChange: (s) => writeFileSync(STATE, JSON.stringify(s, null, 2)),
});

const ev = await breaker.submit({
  agentId: "cli",
  side: side as Side,
  asset,
  notionalUsd: Number(notional),
  leverage: leverage ? Number(leverage) : 1,
});
console.log(JSON.stringify(ev, null, 2));
