// Builds and tests the vault contract in Docker (works the same on Windows, macOS, Linux).
// Usage: pnpm contract test | build
// `build` writes contracts/vault/out/vault.wasm (target/ lives in a Docker volume for speed)

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cmd = process.argv[2] ?? "test";
const inner: Record<string, string> = {
  test: "cargo test",
  build: "cargo near build non-reproducible-wasm && mkdir -p out && cp target/near/vault.wasm out/ && ls -l out/",
};
if (!inner[cmd]) {
  console.error("usage: pnpm contract <test|build>");
  process.exit(1);
}

const run = (args: string[]) => {
  const r = spawnSync("docker", args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(["build", "-q", "-t", "circuit-breaker-contracts", resolve("contracts")]);
run([
  "run",
  "--rm",
  "-v",
  `${resolve("contracts/vault")}:/work`,
  "-v",
  "cb-cargo-registry:/usr/local/cargo/registry",
  "-v",
  "cb-vault-target:/work/target",
  "circuit-breaker-contracts",
  "bash",
  "-c",
  inner[cmd]!,
]);
