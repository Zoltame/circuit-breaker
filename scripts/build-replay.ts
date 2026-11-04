// Builds the hosted demo: the dashboard's static files + a replay of a recorded testnet run.
// Usage: pnpm replay:build [session.json]   -> site/ (deploy with `vercel deploy site --prod`)
//
// Record a session first: pnpm demo --record packages/dashboard/replay/session.json, then click "Run demo".

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = "packages/dashboard/public";
const REPLAY = "packages/dashboard/replay";
const OUT = "site";
const session = process.argv[2] ?? join(REPLAY, "session.json");
if (!existsSync(session)) {
  console.error(`No recording at ${session}. Run: pnpm demo --record ${session}, then click "Run demo".`);
  process.exit(1);
}

// Keep the Vercel project link (site/.vercel) across rebuilds; drop everything else.
for (const f of existsSync(OUT) ? readdirSync(OUT) : []) if (f !== ".vercel") rmSync(join(OUT, f), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Never publish local env files (`vercel link` writes an .env.local with a token).
writeFileSync(join(OUT, ".vercelignore"), [".env*", ".gitignore", ""].join("\n"));
for (const f of readdirSync(PUBLIC)) copyFileSync(join(PUBLIC, f), join(OUT, f));
copyFileSync(join(REPLAY, "replay.js"), join(OUT, "replay.js"));
copyFileSync(join(REPLAY, "replay.css"), join(OUT, "replay.css"));
copyFileSync(session, join(OUT, "session.json"));

const html = readFileSync(join(PUBLIC, "index.html"), "utf8")
  .replace(`<link rel="stylesheet" href="style.css" />`, `<link rel="stylesheet" href="style.css" />\n  <link rel="stylesheet" href="replay.css" />`)
  .replace(`<script src="app.js" type="module"></script>`, `<script src="replay.js"></script>\n  <script src="app.js" type="module"></script>`)
  .replace(
    `<meta name="description" content="Live risk dashboard for an autonomous AI trading agent on NEAR." />`,
    `<meta name="description" content="Replay of a recorded run: a prompt-injected AI trading agent stopped by Circuit Breaker on NEAR testnet." />`,
  );
if (!html.includes("replay.js") || !html.includes("replay.css")) throw new Error("index.html changed: update build-replay.ts");
writeFileSync(join(OUT, "index.html"), html);

const frames = (JSON.parse(readFileSync(session, "utf8")) as { frames: unknown[] }).frames.length;
console.log(`site/ ready: dashboard + replay of ${frames} recorded updates.`);
