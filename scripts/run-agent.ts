// Runs the momentum agent against real NEAR Intents prices (dry quotes, paper fills).
// Usage: pnpm agent [ticks] [intervalSeconds]
// Writes data/decisions.jsonl (journal) and data/state.json (paper account).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { momentum, runAgent } from "@circuit-breaker/agent";
import { CircuitBreaker, JsonlJournal, OneClickClient, PaperBroker, type PaperState } from "@circuit-breaker/executor";
import { loadPolicyYaml } from "@circuit-breaker/policy-engine";

const ticks = Number(process.argv[2] ?? 30);
const intervalMs = Number(process.argv[3] ?? 10) * 1000;
const STATE = "data/state.json";

mkdirSync("data", { recursive: true });
const policy = loadPolicyYaml(readFileSync(process.env.POLICY_FILE ?? "policies/default.yaml", "utf8"));
const broker = existsSync(STATE)
  ? new PaperBroker(JSON.parse(readFileSync(STATE, "utf8")) as PaperState)
  : PaperBroker.fresh(10_000, Date.now());

const breaker = new CircuitBreaker({
  policy,
  broker,
  quoter: new OneClickClient({ baseUrl: process.env.ONECLICK_BASE_URL, jwt: process.env.ONECLICK_JWT, tokenCacheMs: 5_000 }),
  journal: new JsonlJournal("data/decisions.jsonl"),
  onStateChange: (s) => writeFileSync(STATE, JSON.stringify(s, null, 2)),
});

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());

console.log(`agent: ${ticks} ticks every ${intervalMs / 1000}s, policy ${process.env.POLICY_FILE ?? "policies/default.yaml"}`);
await runAgent({
  agentId: "momentum-1",
  asset: "wNEAR",
  strategy: momentum({ lookback: 3, thresholdBps: 5, stepPct: 5 }),
  breaker,
  broker,
  ticks,
  intervalMs,
  signal: stop.signal,
  onDecision: (ev) => {
    const tag = ev.verdict === "allow" ? "ALLOW" : "BLOCK";
    const what = `${ev.order.side} $${ev.order.notionalUsd} ${ev.order.asset}`;
    console.log(`${ev.timestamp} ${tag} ${what.padEnd(24)} ${ev.verdict === "allow" ? `equity $${ev.equityUsd.toFixed(2)}` : ev.reason}`);
  },
});
