// Append-only decision journal (JSONL). One line per event; the dashboard tails this file.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "@circuit-breaker/policy-engine";
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
  | { type: "kill_switch"; timestamp: string; on: boolean; by: string; reason: string; onchain?: OnchainLink };

export interface Journal {
  append(event: JournalEvent): void;
  read(): JournalEvent[];
}

export class JsonlJournal implements Journal {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(event: JournalEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
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
