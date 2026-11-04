// Circuit Breaker dashboard server. One process owns the CircuitBreaker (and optionally runs the agent),
// streams journal events to browsers over SSE, and exposes the kill-switch and red-team actions.
//
// Usage: pnpm dashboard [--onchain] [--agent] [--demo] [--port 8787]
//   --demo shows a "Run demo" button that plays the scripted scenario (src/demo.ts); see `pnpm demo`.
//   --record <file> saves every live update of the next demo run, for the static replay (`pnpm replay:build`).

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { meanReversion, momentum, runAgent } from "@circuit-breaker/agent";
import {
  JOURNAL_FILE,
  PaperBroker,
  buildBreaker,
  type Journal,
  type JournalEvent,
  type VaultConfig,
} from "@circuit-breaker/executor";
import type { Side } from "@circuit-breaker/policy-engine";
import { demoRunning, runDemo } from "./demo.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const portArg = args.indexOf("--port");
const port = Number((portArg >= 0 ? args[portArg + 1] : undefined) ?? process.env.PORT ?? 8787);
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const START_CASH = 10_000;

// ---------------------------------------------------------------- live journal

const recent: JournalEvent[] = [];
const clients = new Set<ServerResponse>();

/** What `--record` captures: every update the browsers receive, with its time offset. */
interface Recording {
  start: number;
  frames: { t: number; kind: string; data: unknown }[];
}
const recordArg = args.indexOf("--record");
const RECORD_FILE = recordArg >= 0 ? args[recordArg + 1] : undefined;
let recording: Recording | null = null;

function broadcast(kind: string, data: unknown): void {
  if (recording) recording.frames.push({ t: Date.now() - recording.start, kind, data });
  const msg = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

const tee = (inner: Journal): Journal => ({
  append(ev) {
    inner.append(ev);
    recent.push(ev);
    if (recent.length > 500) recent.shift();
    void account().then((acc) => broadcast("journal", { event: ev, account: acc }));
    // Anything that may have changed the contract: push its fresh config to the browsers.
    const touchesChain = ev.type === "kill_switch" || ev.type === "vault_direct" || ev.type === "note" || (ev.type === "decision" && ev.execution?.onchain);
    if (touchesChain && vault) {
      vaultCache.at = 0;
      void vaultConfig().then((cfg) => cfg && broadcast("vault", cfg));
    }
  },
  read: () => inner.read(),
});

const { breaker, broker, vault, market } = buildBreaker({ onchain: flag("onchain"), wrapJournal: tee });
recent.push(...breaker.journalTail(200));

// ---------------------------------------------------------------- account view

async function account() {
  const { prices } = await breaker.prices();
  const p = breaker.policy;
  const s = broker.mark(prices, Date.now(), p.swarm);
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  const agents = s.agents
    ? Object.entries(s.agents).map(([id, a]) => ({
        id,
        exposurePct: pct(a.exposureUsd, s.equityUsd),
        budgetPct: p.swarm?.agents[id]?.budgetPct ?? 0,
        equityUsd: a.equityUsd,
        drawdownPct: Math.max(0, pct(a.peakEquityUsd - a.equityUsd, a.peakEquityUsd)),
        maxDrawdownPct: p.swarm?.agents[id]?.maxDrawdownPct ?? 0,
        quarantined: a.quarantined,
      }))
    : null;
  return {
    equityUsd: s.equityUsd,
    startUsd: START_CASH,
    cashUsd: broker.state.cashUsd,
    peakEquityUsd: s.peakEquityUsd,
    drawdownPct: pct(s.peakEquityUsd - s.equityUsd, s.peakEquityUsd),
    dailyLossPct: Math.max(0, pct(s.dayStartEquityUsd - s.equityUsd, s.dayStartEquityUsd)),
    ordersLastHour: s.recentOrderTimes.length,
    exposurePct: Object.fromEntries(Object.entries(s.positionsUsd).map(([a, v]) => [a, pct(v, s.equityUsd)])),
    holdings: broker.state.holdings,
    agents,
    prices,
    killSwitch: s.killSwitch,
    /** Simulated price shocks of the scripted demo (factor per asset); empty outside it. */
    shocks: market.shocks,
    /** Orders that only sell an existing position are still accepted while the kill-switch is on. */
    reduceOnly: s.killSwitch || pct(s.dayStartEquityUsd - s.equityUsd, s.dayStartEquityUsd) >= p.maxDailyLossPct,
    limits: {
      maxDrawdownPct: p.maxDrawdownPct,
      maxDailyLossPct: p.maxDailyLossPct,
      maxOrdersPerHour: p.maxOrdersPerHour,
      maxExposurePct: p.maxExposurePct,
    },
  };
}

async function resetAccount(): Promise<void> {
  broker.state = PaperBroker.fresh(START_CASH, Date.now()).state;
  writeFileSync(JOURNAL_FILE, "");
  recent.length = 0;
  breaker.persist();
  broadcast("reset", { account: await account() });
}

let vaultCache: { at: number; cfg: VaultConfig | null } = { at: 0, cfg: null };
async function vaultConfig(): Promise<VaultConfig | null> {
  if (!vault) return null;
  if (Date.now() - vaultCache.at < 4_000) return vaultCache.cfg;
  try {
    vaultCache = { at: Date.now(), cfg: await vault.getConfig() };
  } catch {
    // keep the last known config
  }
  return vaultCache.cfg;
}

// ---------------------------------------------------------------- red team

// In swarm mode an unlisted id is refused by agent_budget before the other rules run: attack as a listed
// agent so each button still shows the rule it is about.
const RED_AGENT = Object.keys(breaker.policy.swarm?.agents ?? {})[0] ?? "red-team";

const RED_TEAM: Record<string, { label: string; run: () => Promise<unknown> }> = {
  oversize: {
    label: "Oversized order (25% of equity)",
    run: async () => {
      const eq = (await account()).equityUsd;
      return breaker.submit({ agentId: RED_AGENT, side: "buy", asset: "wNEAR", notionalUsd: Math.round(eq * 0.25) });
    },
  },
  unlisted: {
    label: "Buy a token outside the whitelist",
    run: () => breaker.submit({ agentId: RED_AGENT, side: "buy", asset: "PEPE", notionalUsd: 200 }),
  },
  leverage: {
    label: "5x leverage",
    run: () => breaker.submit({ agentId: RED_AGENT, side: "buy", asset: "wNEAR", notionalUsd: 200, leverage: 5 }),
  },
  loop: {
    label: "Runaway loop (15 orders in a row)",
    run: async () => {
      for (let i = 0; i < 15; i++) await breaker.submit({ agentId: RED_AGENT, side: "buy", asset: "wNEAR", notionalUsd: 50 });
    },
  },
  ...(breaker.policy.swarm
    ? {
        rogue: {
          label: "Unlisted agent tries to trade",
          run: () => breaker.submit({ agentId: "rogue-agent", side: "buy", asset: "wNEAR", notionalUsd: 100 }),
        },
        overbudget: {
          label: "A listed agent keeps buying past its own budget",
          // Each order is small enough for the order-size rule, so only the agent's budget can stop the series.
          run: async () => {
            const [id] = Object.keys(breaker.policy.swarm?.agents ?? {});
            const step = Math.floor((await account()).equityUsd * (breaker.policy.maxOrderPct / 100) * 0.9);
            let last;
            for (let i = 0; i < 8; i++) {
              last = await breaker.submit({ agentId: id ?? "momentum-1", side: "buy", asset: "wNEAR", notionalUsd: step });
              if (last.verdict === "block") break;
            }
            return last;
          },
        },
      }
    : {}),
  bypass: {
    label: "Skip the engine: call the vault directly for $10,000",
    run: async () => {
      if (!vault) throw new Error("Start the dashboard with --onchain for this attack");
      const onchain = await vault.executeOrder(`bypass-${Date.now()}`, 10_000);
      const ev: JournalEvent = {
        type: "vault_direct",
        timestamp: new Date().toISOString(),
        label: "Agent key called execute_order directly, skipping the policy engine",
        amountUsd: 10_000,
        onchain: onchain.txHash ? { ...onchain, explorerUrl: vault.explorerUrl(onchain.txHash) } : onchain,
      };
      breaker.journal.append(ev);
      return ev;
    },
  },
};

// ---------------------------------------------------------------- http

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

let agentRunning = false;

function saveRecording(file: string, startVault: VaultConfig | null, frames: Recording["frames"]): void {
  mkdirSync(dirname(file), { recursive: true });
  const session = {
    recordedAt: new Date().toISOString(),
    mode: { onchain: Boolean(vault), agent: false, vaultId: vault?.vaultId ?? null, demo: false, demoRunning: false, shocks: {} },
    policy: breaker.policy,
    redTeam: Object.fromEntries(Object.entries(RED_TEAM).map(([k, v]) => [k, v.label])),
    vault: startVault,
    frames,
  };
  writeFileSync(file, JSON.stringify(session));
  console.log(`Recorded ${frames.length} updates to ${file}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/snapshot") {
      return json(res, 200, {
        mode: {
          onchain: Boolean(vault),
          agent: agentRunning,
          vaultId: vault?.vaultId ?? null,
          demo: flag("demo"),
          demoRunning: demoRunning(),
          shocks: market.shocks,
        },
        policy: breaker.policy,
        account: await account(),
        vault: await vaultConfig(),
        events: recent.slice(-200),
        redTeam: Object.fromEntries(Object.entries(RED_TEAM).map(([k, v]) => [k, v.label])),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/vault") {
      return json(res, 200, await vaultConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/kill-switch") {
      const b = await body(req);
      await breaker.setKillSwitch(Boolean(b.on), "dashboard", String(b.reason ?? (b.on ? "Manual stop" : "Manual release")));
      vaultCache.at = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/release-agent") {
      const b = await body(req);
      await breaker.releaseAgent(String(b.agentId), "dashboard", "Operator released the agent");
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/flatten") {
      const out = await breaker.flatten("dashboard", "Operator requested flatten");
      vaultCache.at = 0;
      return json(res, 200, { ok: true, orders: out.length });
    }
    if (req.method === "POST" && url.pathname === "/api/propose") {
      const b = await body(req);
      const ev = await breaker.submit({
        agentId: String(b.agentId ?? "dashboard"),
        side: (b.side === "sell" ? "sell" : "buy") as Side,
        asset: String(b.asset ?? "wNEAR"),
        notionalUsd: Number(b.notionalUsd ?? 100),
        leverage: Number(b.leverage ?? 1),
      });
      return json(res, 200, ev);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/red-team/")) {
      const attack = RED_TEAM[url.pathname.slice("/api/red-team/".length)];
      if (!attack) return json(res, 404, { error: "unknown attack" });
      const out = await attack.run();
      vaultCache.at = 0;
      return json(res, 200, out ?? { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      await resetAccount();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/demo") {
      if (demoRunning()) return json(res, 409, { error: "The demo is already running" });
      const startVault = await vaultConfig();
      if (RECORD_FILE) recording = { start: Date.now(), frames: [] };
      // Runs in the background: the browser follows it through the live journal.
      void runDemo({
        breaker,
        vault,
        market,
        reset: resetAccount,
        equity: async () => {
          const { prices } = await breaker.prices();
          const s = broker.mark(prices, Date.now());
          return { equityUsd: s.equityUsd, exposureUsd: Object.values(s.positionsUsd).reduce((a, b) => a + b, 0) };
        },
        pauseMs: Number(process.env.CB_DEMO_PAUSE_MS ?? 2_500),
        daoEnabled: Boolean(process.env.DAO_ACCOUNT_ID && process.env.DAO_COUNCIL),
      })
        .catch((err) => console.error("demo:", err))
        .finally(() => {
          broadcast("demo", { running: false });
          // Broadcasts are async (each waits for a fresh account view): let the last ones land in the recording.
          if (RECORD_FILE && recording) {
            setTimeout(() => {
              if (!recording) return;
              saveRecording(RECORD_FILE, startVault, recording.frames);
              recording = null;
            }, 4_000);
          }
        });
      broadcast("demo", { running: true });
      return json(res, 202, { ok: true });
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
      const file = join(PUBLIC, rel);
      if (file.startsWith(PUBLIC) && existsSync(file)) {
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
        return;
      }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// The drawdown limit is enforced here too, not only when an order shows up: if the agent stops trading
// (or is not running), a breach still trips the kill-switch and unwinds the positions.
setInterval(() => void breaker.monitor().catch((err) => console.error("monitor:", err)), 10_000);

// Prices move even when nothing is traded: refresh the gauges every 10 s.
setInterval(() => {
  if (clients.size > 0) void account().then((acc) => broadcast("account", acc)).catch(() => undefined);
}, 10_000);

server.listen(port, () => {
  console.log(`Circuit Breaker dashboard: http://localhost:${port}  (vault: ${vault ? vault.vaultId : "off"}, agent: ${flag("agent") ? "on" : "off"})`);
});

if (flag("agent") && breaker.policy.swarm) {
  // Swarm demo: two agents with opposite strategies share one account, each under its own budget.
  agentRunning = true;
  const common = { asset: "wNEAR", breaker, broker, ticks: Number.POSITIVE_INFINITY, intervalMs: 10_000 };
  void Promise.all([
    runAgent({ ...common, agentId: "momentum-1", strategy: momentum({ lookback: 3, thresholdBps: 5, stepPct: 5 }) }),
    runAgent({ ...common, agentId: "meanrev-1", strategy: meanReversion({ lookback: 6, thresholdBps: 5, stepPct: 5 }) }),
  ]).finally(() => (agentRunning = false));
} else if (flag("agent")) {
  agentRunning = true;
  void runAgent({
    agentId: "momentum-1",
    asset: "wNEAR",
    strategy: momentum({ lookback: 3, thresholdBps: 5, stepPct: 5 }),
    breaker,
    broker,
    ticks: Number.POSITIVE_INFINITY,
    intervalMs: 10_000,
  }).finally(() => (agentRunning = false));
}
