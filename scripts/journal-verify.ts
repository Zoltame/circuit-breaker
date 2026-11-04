// Verifies a decision journal: recomputes its hash chain and compares it with the anchors held by the vault.
// Usage: pnpm journal:verify [path/to/decisions.jsonl] [--journal <id>]   (default path: the dashboard's journal)
//   --journal: the journal under audit (as published, e.g. in the anchor events of the vault). Without it the
//   id is read from the file itself, so a file whose first entry was rewritten shows as NOT_ANCHORED, not
//   TAMPERED: an auditor should always pass the id they expect.
// Exit code 0 = intact, 1 = tampered, 2 = consistent but not anchored. Needs no key: anchors are read-only.

import { JOURNAL_FILE, readVaultAnchors, verifyJournalFile } from "@circuit-breaker/executor";

const args = process.argv.slice(2);
const at = args.indexOf("--journal");
const expected = at >= 0 ? args[at + 1] : undefined;
const path = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1)) ?? JOURNAL_FILE;
const vaultId = process.env.VAULT_ACCOUNT_ID;
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const vault = vaultId ? { getAnchors: (journalId: string) => readVaultAnchors(rpcUrl, vaultId, journalId) } : undefined;

const v = await verifyJournalFile(path, vault, expected);
const icon = { intact: "✓", tampered: "✗", not_anchored: "…" }[v.verdict];
console.log(`${icon} ${v.verdict.toUpperCase()}  ${path}`);
console.log(`  ${v.message}`);
if (v.journalId) console.log(`  journal ${v.journalId}, ${v.entries} chained entries${v.legacy ? `, ${v.legacy} older unchained lines` : ""}`);
if (vaultId) console.log(`  anchors read from ${vaultId}: ${v.anchors}`);
if (!expected && v.verdict === "not_anchored") console.log("  tip: pass --journal <id> to check the file against the journal you expect");
process.exitCode = v.verdict === "intact" ? 0 : v.verdict === "tampered" ? 1 : 2;
