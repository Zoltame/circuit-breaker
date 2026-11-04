import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnchoringJournal, verifyJournalLines } from "../src/anchor.ts";
import { GENESIS, checkAgainstAnchors, forgeChain, sealEntry, verifyChain, type AnchorPoint } from "../src/chain.ts";
import { JsonlJournal, MemoryJournal, type JournalEvent } from "../src/journal.ts";
import type { OnchainResult } from "../src/vault.ts";

const note = (i: number): JournalEvent => ({ type: "note", timestamp: `2026-11-04T12:00:${String(i).padStart(2, "0")}.000Z`, text: `entry ${i}` });

/** Builds a sealed journal of n notes, as JsonlJournal writes it. */
function sealed(n: number): string[] {
  const lines: string[] = [];
  let prev = GENESIS;
  for (let i = 0; i < n; i++) {
    const { line, hash } = sealEntry(note(i), i, prev);
    lines.push(line);
    prev = hash;
  }
  return lines;
}

/** What a careful attacker does: change one entry, then recompute every hash after it. */
function forge(lines: string[], at: number, change: (e: Record<string, unknown>) => void): string[] {
  const out = forgeChain(lines, (e, seq) => {
    if (seq !== at) return undefined;
    change(e);
    return e;
  });
  expect(out.editedSeq).toBe(at);
  return out.lines;
}

const anchorsOf = (lines: string[], seqs: number[]): AnchorPoint[] =>
  seqs.map((seq) => ({ seq, hash: (JSON.parse(lines[seq]!) as { hash: string }).hash }));

describe("hash chain", () => {
  it("accepts an untouched journal and names it after its first entry", () => {
    const c = verifyChain(sealed(5));
    expect(c.error).toBeNull();
    expect(c.entries).toBe(5);
    expect(c.journalId).toMatch(/^j-[0-9a-f]{16}$/);
    expect(c.head?.seq).toBe(4);
  });

  it("finds an edited entry", () => {
    const lines = sealed(5);
    lines[2] = lines[2]!.replace("entry 2", "entry 2 (edited)");
    expect(verifyChain(lines).error).toEqual({ line: 3, reason: expect.stringContaining("modified") });
  });

  it("finds a deleted entry", () => {
    const lines = sealed(5);
    lines.splice(2, 1);
    expect(verifyChain(lines).error?.line).toBe(3);
  });

  it("tolerates lines written before the chain existed, but not inside it", () => {
    const legacy = JSON.stringify({ type: "note", timestamp: "2026-11-01T00:00:00.000Z", text: "old" });
    expect(verifyChain([legacy, ...sealed(3)])).toMatchObject({ legacy: 1, entries: 3, error: null });
    const lines = sealed(3);
    lines.splice(1, 0, legacy);
    expect(verifyChain(lines).error?.reason).toContain("without hash");
  });
});

describe("anchors", () => {
  const lines = sealed(25);

  it("reports an intact, anchored journal", () => {
    const v = checkAgainstAnchors(verifyChain(lines), anchorsOf(lines, [9, 19]));
    expect(v.verdict).toBe("intact");
    expect(v.message).toContain("5 newer entries");
  });

  it("catches a rewritten history even when every local hash was recomputed", () => {
    const forged = forge(lines, 4, (e) => (e.text = "nothing happened here"));
    const chain = verifyChain(forged);
    expect(chain.error).toBeNull(); // the forgery is self-consistent…
    const v = checkAgainstAnchors(chain, anchorsOf(lines, [9, 19])); // …but the chain remembers
    expect(v.verdict).toBe("tampered");
    expect(v.message).toContain("Entry #9");
  });

  it("catches a truncated journal", () => {
    const v = checkAgainstAnchors(verifyChain(lines.slice(0, 15)), anchorsOf(lines, [9, 19]));
    expect(v).toMatchObject({ verdict: "tampered", message: expect.stringContaining("truncated") });
  });

  it("says so when nothing is anchored yet", () => {
    expect(checkAgainstAnchors(verifyChain(lines), []).verdict).toBe("not_anchored");
  });

  it("catches a rewritten first entry, which renames the journal, when the auditor names the journal", async () => {
    const id = verifyChain(lines).journalId!;
    const forged = forge(lines, 0, (e) => (e.text = "nothing happened here"));
    const vault = { getAnchors: async (j: string) => (j === id ? anchorsOf(lines, [9, 19]) : []) };
    // Without the expected id the forgery passes as a brand-new journal that was never anchored…
    expect((await verifyJournalLines(forged, vault)).verdict).toBe("not_anchored");
    // …with it, it is caught.
    const v = await verifyJournalLines(forged, vault, id);
    expect(v).toMatchObject({ verdict: "tampered", message: expect.stringContaining("first entry was rewritten") });
    expect((await verifyJournalLines(lines, vault, id)).verdict).toBe("intact");
  });
});

describe("JsonlJournal", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "cb-journal-")), "j.jsonl");

  it("seals every entry, restarts the chain after a reset, and refuses to extend a tampered file", () => {
    const path = tmp();
    const j = new JsonlJournal(path);
    for (let i = 0; i < 3; i++) j.append(note(i));
    expect(verifyChain(readFileSync(path, "utf8").split("\n"))).toMatchObject({ entries: 3, error: null });
    expect(j.head()?.seq).toBe(2);

    writeFileSync(path, ""); // dashboard reset
    j.append(note(9));
    expect(j.head()?.seq).toBe(0);

    j.append(note(10));
    writeFileSync(path, readFileSync(path, "utf8").replace("entry 9", "entry 99"));
    expect(() => j.append(note(11))).toThrow(/fails verification/);
  });
});

describe("AnchoringJournal", () => {
  function setup(every = 3) {
    const anchored: { journalId: string; seq: number; hash: string }[] = [];
    const vault = {
      explorerUrl: (h: string) => `https://explorer/${h}`,
      anchorJournal: async (journalId: string, seq: number, hash: string): Promise<OnchainResult> => {
        anchored.push({ journalId, seq, hash });
        return { status: "settled", txHash: `tx${anchored.length}` };
      },
      getAnchors: async () => anchored.map(({ seq, hash }) => ({ seq, hash })),
    };
    const path = join(mkdtempSync(join(tmpdir(), "cb-anchor-")), "j.jsonl");
    const journal = new AnchoringJournal(new JsonlJournal(path), vault, every);
    return { journal, anchored, vault, lines: () => readFileSync(path, "utf8").split("\n") };
  }

  it("anchors every N entries and at once after a kill-switch, and logs each anchor in the chain", async () => {
    const { journal, anchored, vault, lines } = setup(3);
    for (let i = 0; i < 3; i++) journal.append(note(i));
    await journal.anchor();
    expect(anchored.map((a) => a.seq)).toEqual([2]);

    journal.append({ type: "kill_switch", timestamp: "2026-11-04T12:01:00.000Z", on: true, by: "policy:max_drawdown", reason: "dd" });
    await journal.anchor();
    expect(anchored.map((a) => a.seq)).toEqual([2, 4]); // entry 3 is the first anchor's own log line

    const events = journal.read().filter((e) => e.type === "anchor");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ anchoredSeq: 2, onchain: { status: "settled", explorerUrl: "https://explorer/tx1" } });

    expect((await verifyJournalLines(lines(), vault)).verdict).toBe("intact");
  });

  it("does not anchor the same head twice", async () => {
    const { journal, anchored } = setup(100);
    journal.append(note(0));
    await journal.anchor();
    await journal.anchor();
    expect(anchored).toHaveLength(1);
  });

  it("is a plain pass-through for a journal without a chain", async () => {
    const mem = new MemoryJournal();
    const j = new AnchoringJournal(mem, { explorerUrl: (h) => h, anchorJournal: async () => ({ status: "settled" }) }, 1);
    j.append(note(0));
    await j.anchor();
    expect(mem.events).toHaveLength(1);
  });
});
