// Hash chain of the decision journal. Every line carries `seq`, `prev` (hash of the previous line) and
// `hash` = SHA-256(prev + "\n" + the line without `hash`). Editing, inserting or deleting a line breaks every
// hash after it. An attacker who rewrites a line AND recomputes all the hashes after it gets a valid-looking
// chain, which is why the head is also anchored on-chain (see anchor.ts): anchored hashes can't be recomputed.

import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

export interface ChainFields {
  seq: number;
  prev: string;
  hash: string;
}

/** Where the journal stands: its id (from its first entry) and its last entry. */
export interface ChainHead {
  journalId: string;
  seq: number;
  hash: string;
}

/** An anchored position, as stored by the vault's `anchor_journal`. */
export interface AnchorPoint {
  seq: number;
  hash: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A journal is named after the hash of its first entry, so two journals never share an id. */
export const journalIdOf = (genesisHash: string): string => `j-${genesisHash.slice(0, 16)}`;

/** Seals one event as entry `seq` after `prev`. Returns the JSONL line and its hash. */
export function sealEntry(event: object, seq: number, prev: string): { line: string; hash: string } {
  const { seq: _s, prev: _p, hash: _h, ...body } = event as Record<string, unknown>;
  const unsealed = { ...body, seq, prev };
  const hash = sha256(`${prev}\n${JSON.stringify(unsealed)}`);
  return { line: JSON.stringify({ ...unsealed, hash }), hash };
}

export interface ChainCheck {
  /** Chained entries checked. */
  entries: number;
  /** Lines before the chain started (journal written before hashing existed): not protected. */
  legacy: number;
  journalId: string | null;
  head: ChainHead | null;
  /** Hash of every chained entry by seq, for the anchor comparison. */
  hashes: Map<number, string>;
  /** First problem found, with its 1-based line number in the file. */
  error: { line: number; reason: string } | null;
}

/** Recomputes the chain of a JSONL journal. Pure: no I/O. */
export function verifyChain(lines: string[]): ChainCheck {
  const out: ChainCheck = { entries: 0, legacy: 0, journalId: null, head: null, hashes: new Map(), error: null };
  let prev: string | null = null;
  for (const [i, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    const fail = (reason: string): ChainCheck => ({ ...out, error: { line: i + 1, reason } });
    let entry: Partial<ChainFields> & Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as typeof entry;
    } catch {
      return fail("not valid JSON");
    }
    if (typeof entry.hash !== "string") {
      if (prev !== null) return fail("entry without hash inside the chain");
      out.legacy++;
      continue;
    }
    const expectedPrev: string = prev ?? GENESIS;
    const expectedSeq = out.entries;
    if (entry.seq !== expectedSeq) return fail(`expected entry #${expectedSeq}, found #${String(entry.seq)}: an entry was removed or inserted`);
    if (entry.prev !== expectedPrev) return fail(`entry #${expectedSeq} does not follow the previous one: an entry was removed, inserted or changed`);
    const { line, hash } = sealEntry(entry, expectedSeq, expectedPrev);
    if (hash !== entry.hash || line !== raw.trim()) return fail(`entry #${expectedSeq} was modified after it was written (hash mismatch)`);
    if (expectedSeq === 0) out.journalId = journalIdOf(hash);
    out.hashes.set(expectedSeq, hash);
    out.entries++;
    prev = hash;
  }
  if (out.journalId && prev) out.head = { journalId: out.journalId, seq: out.entries - 1, hash: prev };
  return out;
}

export type JournalVerdict = "intact" | "tampered" | "not_anchored";

export interface JournalVerification extends ChainCheck {
  verdict: JournalVerdict;
  message: string;
  /** Anchors read from the vault for this journal. */
  anchors: number;
  lastAnchoredSeq: number | null;
}

/**
 * Compares the local chain with the anchors the vault holds for it. `expectedJournalId` is the journal under
 * audit: a journal is named after its first entry, so rewriting entry #0 yields a "new" journal with no anchors;
 * with the expected id that is caught as tampering instead of passing as "not anchored yet".
 */
export function checkAgainstAnchors(chain: ChainCheck, anchors: AnchorPoint[] | null, expectedJournalId?: string): JournalVerification {
  const base = { ...chain, anchors: anchors?.length ?? 0, lastAnchoredSeq: anchors?.at(-1)?.seq ?? null };
  if (chain.error) {
    return { ...base, verdict: "tampered", message: `Line ${chain.error.line}: ${chain.error.reason}` };
  }
  if (expectedJournalId && chain.journalId !== expectedJournalId) {
    return {
      ...base,
      verdict: "tampered",
      error: { line: chain.legacy + 1, reason: "journal id mismatch" },
      message: `This file is journal ${chain.journalId ?? "(empty)"}, not ${expectedJournalId}: its first entry was rewritten or the file was replaced`,
    };
  }
  for (const a of anchors ?? []) {
    const local = chain.hashes.get(a.seq);
    if (local === undefined) {
      return {
        ...base,
        verdict: "tampered",
        error: { line: chain.legacy + chain.entries, reason: "truncated" },
        message: `Entry #${a.seq} was anchored on-chain but is missing: the journal was truncated`,
      };
    }
    if (local !== a.hash) {
      return {
        ...base,
        verdict: "tampered",
        error: { line: chain.legacy + a.seq + 1, reason: "anchor mismatch" },
        message: `Entry #${a.seq} differs from the hash anchored on-chain: history was rewritten (even though the local chain looks consistent)`,
      };
    }
  }
  if (!anchors || anchors.length === 0) {
    return { ...base, verdict: "not_anchored", message: `Chain of ${chain.entries} entries is consistent, but nothing is anchored on-chain yet` };
  }
  const tail = chain.entries - 1 - (base.lastAnchoredSeq ?? -1);
  return {
    ...base,
    verdict: "intact",
    message: `${chain.entries} entries, chain consistent, ${anchors.length} on-chain anchors match (last: #${base.lastAnchoredSeq}${tail > 0 ? `, ${tail} newer entries not anchored yet` : ""})`,
  };
}

/**
 * What an attacker with write access to the file can do: edit entries and recompute every hash after them, so
 * the local chain stays consistent. Only the on-chain anchors can tell. Used by the red-team demo and tests;
 * returns the forged lines and the seq of the first edited entry (null when `edit` changed nothing).
 */
export function forgeChain(
  lines: string[],
  edit: (entry: Record<string, unknown>, seq: number) => Record<string, unknown> | undefined,
): { lines: string[]; editedSeq: number | null } {
  const out: string[] = [];
  let prev = GENESIS;
  let seq = 0;
  let editedSeq: number | null = null;
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (typeof entry.hash !== "string") {
      out.push(raw.trim());
      continue;
    }
    const changed = edit(structuredClone(entry), seq);
    if (changed && editedSeq === null) editedSeq = seq;
    const { line, hash } = sealEntry(changed ?? entry, seq, prev);
    out.push(line);
    prev = hash;
    seq++;
  }
  return { lines: out, editedSeq };
}
