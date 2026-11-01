// Runs the momentum agent against real NEAR Intents prices (dry quotes, paper fills).
// Usage: pnpm agent [ticks] [intervalSeconds] [--onchain]
// Writes data/decisions.jsonl (journal) and data/state.json (paper account).

import { momentum, runAgent } from "@circuit-breaker/agent";
import { POLICY_FILE, buildBreaker } from "./lib/breaker.ts";

const onchain = process.argv.includes("--onchain");
const [ticksArg, intervalArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ticks = Number(ticksArg ?? 30);
const intervalMs = Number(intervalArg ?? 10) * 1000;

const { breaker, broker } = buildBreaker({ onchain });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());

console.log(`agent: ${ticks} ticks every ${intervalMs / 1000}s, policy ${POLICY_FILE}${onchain ? ", on-chain vault" : ""}`);
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
    const detail = ev.verdict === "allow" ? `${ev.execution?.status ?? ""} equity $${ev.equityUsd.toFixed(2)}` : ev.reason;
    console.log(`${ev.timestamp} ${tag} ${what.padEnd(24)} ${detail}`);
  },
});
