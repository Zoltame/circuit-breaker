// Anchors the journal head in the vault: every `every` entries, and right away after the events that matter
// most in an incident (kill-switch, flatten, quarantine, direct vault call). Once anchored, an entry can't be
// rewritten without the on-chain hash giving it away, even if the attacker recomputes the whole local chain.

import { existsSync, readFileSync } from "node:fs";
import { checkAgainstAnchors, verifyChain, type JournalVerification } from "./chain.ts";
import type { Journal, JournalEvent, OnchainLink } from "./journal.ts";
import type { OnchainResult, VaultGateway } from "./vault.ts";

const ANCHOR_NOW: ReadonlySet<JournalEvent["type"]> = new Set(["kill_switch", "flatten", "agent_quarantine", "vault_direct"]);

export class AnchoringJournal implements Journal {
  private since = 0;
  /** Up to which entry (in which journal) there is nothing new to anchor: the last anchor's own log line. */
  private upToDate: { journalId: string; seq: number } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly inner: Journal,
    private readonly vault: Pick<VaultGateway, "anchorJournal" | "explorerUrl">,
    private readonly every = 10,
  ) {}

  append(event: JournalEvent): void {
    this.inner.append(event);
    if (event.type === "anchor") return;
    this.since++;
    if (this.since >= this.every || ANCHOR_NOW.has(event.type)) void this.anchor();
  }

  read(): JournalEvent[] {
    return this.inner.read();
  }

  head() {
    return this.inner.head?.();
  }

  /** Anchors the current head now (no-op if it is already anchored). Resolves once the anchor is recorded. */
  anchor(): Promise<void> {
    const run = this.chain.then(() => this.anchorHead());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async anchorHead(): Promise<void> {
    const head = this.inner.head?.();
    if (!head || !this.vault.anchorJournal) return;
    if (this.upToDate?.journalId === head.journalId && this.upToDate.seq >= head.seq) return;
    this.since = 0;
    const r: OnchainResult = await this.vault.anchorJournal(head.journalId, head.seq, head.hash);
    const onchain: OnchainLink = r.txHash ? { ...r, explorerUrl: this.vault.explorerUrl(r.txHash) } : r;
    this.inner.append({ type: "anchor", timestamp: new Date().toISOString(), journalId: head.journalId, anchoredSeq: head.seq, anchoredHash: head.hash, onchain });
    // The log line of a successful anchor is not worth an anchor of its own; a failed one is retried later.
    if (r.status === "settled") this.upToDate = { journalId: head.journalId, seq: this.inner.head?.()?.seq ?? head.seq };
  }
}

/**
 * Verifies a journal file against its chain and, when a vault is given, against the anchors it holds.
 * `expectedJournalId`: the journal under audit (see checkAgainstAnchors); its anchors are the ones compared.
 */
export async function verifyJournalFile(
  path: string,
  vault?: Pick<VaultGateway, "getAnchors">,
  expectedJournalId?: string,
): Promise<JournalVerification> {
  return verifyJournalLines(existsSync(path) ? readFileSync(path, "utf8").split("\n") : [], vault, expectedJournalId);
}

export async function verifyJournalLines(
  lines: string[],
  vault?: Pick<VaultGateway, "getAnchors">,
  expectedJournalId?: string,
): Promise<JournalVerification> {
  const chain = verifyChain(lines);
  const id = expectedJournalId ?? chain.journalId;
  const anchors = id && vault?.getAnchors ? await vault.getAnchors(id) : null;
  return checkAgainstAnchors(chain, anchors, expectedJournalId);
}
