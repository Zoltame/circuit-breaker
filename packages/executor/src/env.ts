// Builds the CircuitBreaker from environment variables, shared by the CLI scripts and the dashboard server.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { JsonlJournal, type Journal } from "./journal.ts";
import { OneClickClient } from "./oneclick.ts";
import { PaperBroker, type PaperState } from "./paper.ts";
import { NearVaultGateway } from "./vault.ts";
import { loadPolicyYaml } from "@circuit-breaker/policy-engine";
import type { KeyPairString } from "near-api-js";

/** `--name value` from the command line, e.g. `--policy policies/swarm.yaml`. */
const cliArg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const DATA_DIR = cliArg("data") ?? process.env.CB_DATA_DIR ?? "data";
export const STATE_FILE = `${DATA_DIR}/state.json`;
export const JOURNAL_FILE = `${DATA_DIR}/decisions.jsonl`;
export const POLICY_FILE = cliArg("policy") ?? process.env.POLICY_FILE ?? "policies/default.yaml";

export interface Built {
  breaker: CircuitBreaker;
  broker: PaperBroker;
  journal: Journal;
  vault: NearVaultGateway | undefined;
}

/** `onchain`: buys must also settle through the testnet vault with the agent's function-call key. */
/** `wrapJournal` lets the dashboard tee journal events to live clients. */
export function buildBreaker(opts: { onchain?: boolean; wrapJournal?: (j: Journal) => Journal } = {}): Built {
  mkdirSync(DATA_DIR, { recursive: true });
  const broker = existsSync(STATE_FILE)
    ? new PaperBroker(JSON.parse(readFileSync(STATE_FILE, "utf8")) as PaperState)
    : PaperBroker.fresh(10_000, Date.now());
  const file = new JsonlJournal(JOURNAL_FILE);
  const journal = opts.wrapJournal ? opts.wrapJournal(file) : file;

  let vault: NearVaultGateway | undefined;
  if (opts.onchain) {
    const { VAULT_ACCOUNT_ID, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY, VENUE_ACCOUNT_ID } = process.env;
    if (!VAULT_ACCOUNT_ID || !AGENT_ACCOUNT_ID || !AGENT_PRIVATE_KEY || !VENUE_ACCOUNT_ID) {
      throw new Error("--onchain needs VAULT_ACCOUNT_ID, AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY, VENUE_ACCOUNT_ID in .env");
    }
    vault = new NearVaultGateway({
      rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
      vaultId: VAULT_ACCOUNT_ID,
      agentId: AGENT_ACCOUNT_ID,
      privateKey: AGENT_PRIVATE_KEY as KeyPairString,
      venueId: VENUE_ACCOUNT_ID,
      ...(process.env.VAULT_NEAR_PER_USD ? { nearPerUsd: Number(process.env.VAULT_NEAR_PER_USD) } : {}),
    });
  }

  const breaker = new CircuitBreaker({
    policy: loadPolicyYaml(readFileSync(POLICY_FILE, "utf8")),
    broker,
    quoter: new OneClickClient({ baseUrl: process.env.ONECLICK_BASE_URL, jwt: process.env.ONECLICK_JWT, tokenCacheMs: 5_000 }),
    journal,
    vault,
    onStateChange: (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)),
  });
  return { breaker, broker, journal, vault };
}
