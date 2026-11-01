// Deploys and configures the vault on testnet with near-cli-rs (owner keys stay in the OS keychain).
// Then gives the agent a NEW function-call key scoped to the vault and writes it to .env.
//
// Prereqs: `pnpm contract build`, near-cli-rs, and in .env: VAULT_ACCOUNT_ID, AGENT_ACCOUNT_ID, VENUE_ACCOUNT_ID.
// The vault account is its own owner (its full-access key is the human operator's).
// Usage: pnpm vault:deploy [maxPerOrderNear] [maxPerDayNear]

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const vault = process.env.VAULT_ACCOUNT_ID;
const agent = process.env.AGENT_ACCOUNT_ID;
const venue = process.env.VENUE_ACCOUNT_ID;
if (!vault || !agent || !venue) {
  console.error("Set VAULT_ACCOUNT_ID, AGENT_ACCOUNT_ID and VENUE_ACCOUNT_ID in .env");
  process.exit(1);
}
const perOrder = process.argv[2] ?? "1";
const perDay = process.argv[3] ?? "3";
const yocto = (near: string) => (BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n).toString();

function near(args: string[]): void {
  console.log(`\n$ near ${args.join(" ")}`);
  const r = spawnSync("near", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const q = (s: string) => (process.platform === "win32" ? `"${s.replaceAll('"', '\\"')}"` : s);
const sign = ["network-config", NETWORK, "sign-with-keychain", "send"];
const call = (method: string, args: object) =>
  near([
    "contract", "call-function", "as-transaction", vault, method, "json-args", q(JSON.stringify(args)),
    "prepaid-gas", q("30 Tgas"), "attached-deposit", q("0 NEAR"), "sign-as", vault, ...sign,
  ]);

// 1. Deploy + init
near([
  "contract", "deploy", vault, "use-file", "contracts/vault/out/vault.wasm",
  "with-init-call", "new", "json-args", q(JSON.stringify({ owner_id: vault, agent_id: agent })),
  "prepaid-gas", q("100 Tgas"), "attached-deposit", q("0 NEAR"), ...sign,
]);

// 2. Limits and venue
call("set_token_limits", { token: "near", max_per_order: yocto(perOrder), max_per_day: yocto(perDay) });
call("add_venue", { venue });

// 3. Agent key: function calls only, only on the vault, only these two methods
const key = KeyPair.fromRandom("ed25519");
near([
  "account", "add-key", agent, "grant-function-call-access",
  "--allowance", q("1 NEAR"), "--contract-account-id", vault, "--function-names", "execute_order,trip_kill_switch",
  "use-manually-provided-public-key", key.getPublicKey().toString(), ...["network-config", NETWORK, "sign-with-keychain", "send"],
]);

const env = readFileSync(".env", "utf8").replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${key.toString()}`);
writeFileSync(".env", env);
console.log(`\nVault ${vault} ready: ${perOrder} NEAR/order, ${perDay} NEAR/day, venue ${venue}.`);
console.log(`Agent key ${key.getPublicKey().toString()} written to .env (function-call only, scoped to the vault).`);
