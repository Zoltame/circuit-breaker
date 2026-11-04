// Append-only decision journal (JSONL). One line per event; the dashboard tails this file.
// Each line is sealed into a hash chain (chain.ts) whose head can be anchored on-chain (anchor.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "@circuit-breaker/policy-engine";
import { GENESIS, journalIdOf, sealEntry, verifyChain, type ChainHead } from "./chain.ts";
import type { OnchainResult } from "./vault.ts";

export type OnchainLink = OnchainResult & { explorerUrl?: string };

export interface Execution {
  status: "filled" | "failed";
  /** Paper fill: units of the asset and USDC moved. */
  units?: number;
  cashDelta?: number;
  error?: string;
  /** On-chain vault leg, when a vault is configured. */
  onchain?: OnchainLink;
}

export type JournalEvent =
  | ({ type: "decision"; execution?: Execution; equityUsd: number } & Decision)
  | { type: "kill_switch"; timestamp: string; on: boolean; by: string; reason: string; onchain?: OnchainLink }
  /** An agent of the swarm hit its own drawdown limit (on) or was released by the operator (off). */
  | { type: "agent_quarantine"; timestamp: string; agentId: string; on: boolean; reason: string; drawdownPct?: number }
  /** Every held position is being sold through reduce-only exits (auto-flatten or operator request). */
  | { type: "flatten"; timestamp: string; by: string; reason: string; positions: string[] }
  /** Narration of the scripted demo (`pnpm demo`): an act title or a step, shown in the feed. */
  | { type: "note"; timestamp: string; act?: string; text: string; tone?: "info" | "attack" | "ok" }
  /** The agent's key called the vault directly, skipping the policy engine (red-team demo). */
  | { type: "vault_direct"; timestamp: string; label: string; amountUsd: number; onchain: OnchainLink }
  /** The journal head (entry `seq`, hash `hash`) was written to the vault, where it can't be changed. */
  /** (`anchoredSeq`/`anchoredHash`, because `seq` and `hash` are the chain fields every sealed line carries.) */
  | { type: "anchor"; timestamp: string; journalId: string; anchoredSeq: number; anchoredHash: string; onchain: OnchainLink };

export interface Journal {
  append(event: JournalEvent): void;
  read(): JournalEvent[];
  /** Last sealed entry, when the journal is hash-chained. */
  head?(): ChainHead | undefined;
}

export class JsonlJournal implements Journal {
  /** Head of the chain and the file size it was computed for: a reset (truncated file) is noticed. */
  private cache: { size: number; head: ChainHead | undefined } | null = null;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: JournalEvent): void {
    const prev = this.head();
    const seq = prev ? prev.seq + 1 : 0;
    const { line, hash } = sealEntry(event, seq, prev?.hash ?? GENESIS);
    appendFileSync(this.path, `${line}\n`);
    this.cache = { size: this.size(), head: { journalId: prev?.journalId ?? journalIdOf(hash), seq, hash } };
  }

  head(): ChainHead | undefined {
    const size = this.size();
    if (this.cache && this.cache.size === size) return this.cache.head;
    // First use, or the file changed under us (a reset, or someone else wrote it): rebuild from the file.
    const check = verifyChain(existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n") : []);
    if (check.error) {
      throw new Error(`Journal ${this.path} fails verification (line ${check.error.line}: ${check.error.reason}): refusing to append`);
    }
    this.cache = { size, head: check.head ?? undefined };
    return this.cache.head;
  }

  private size(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  read(): JournalEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as JournalEvent);
  }
}

export class MemoryJournal implements Journal {
  readonly events: JournalEvent[] = [];
  append(event: JournalEvent): void {
    this.events.push(event);
  }
  read(): JournalEvent[] {
    return [...this.events];
  }
}
