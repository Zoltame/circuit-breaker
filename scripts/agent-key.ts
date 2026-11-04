// Rotates the agent's function-call key: adds a new key scoped to the vault (execute_order, trip_kill_switch,
// anchor_journal), writes it to .env, then deletes the previous key from the agent account.
// The agent account's own full-access key (OS keychain) signs both changes.
// Usage: pnpm agent:rotate-key

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { KeyPair, type KeyPairString } from "near-api-js";

export const AGENT_METHODS = ["execute_order", "trip_kill_switch", "anchor_journal"];

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const { VAULT_ACCOUNT_ID: vault, AGENT_ACCOUNT_ID: agent, AGENT_PRIVATE_KEY: oldKey } = process.env;
if (!vault || !agent) {
  console.error("Set VAULT_ACCOUNT_ID and AGENT_ACCOUNT_ID in .env");
  process.exit(1);
}

const q = (s: string) => (process.platform === "win32" ? `"${s.replaceAll('"', '\\"')}"` : s);
function near(args: string[]): void {
  console.log(`\n$ near ${args.join(" ")}`);
  const r = spawnSync("near", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const sign = ["network-config", NETWORK, "sign-with-keychain", "send"];

const key = KeyPair.fromRandom("ed25519");
near([
  "account", "add-key", agent, "grant-function-call-access",
  "--allowance", q("1 NEAR"), "--contract-account-id", vault, "--function-names", AGENT_METHODS.join(","),
  "use-manually-provided-public-key", key.getPublicKey().toString(), ...sign,
]);
writeFileSync(".env", readFileSync(".env", "utf8").replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${key.toString()}`));
console.log(`\nNew agent key ${key.getPublicKey().toString()} written to .env (${AGENT_METHODS.join(", ")} on ${vault}).`);

if (oldKey) {
  const oldPublic = KeyPair.fromString(oldKey as KeyPairString).getPublicKey().toString();
  near(["account", "delete-keys", agent, "public-keys", oldPublic, ...sign]);
  console.log(`Previous agent key ${oldPublic} deleted.`);
}
