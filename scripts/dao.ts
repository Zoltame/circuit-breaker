// Sputnik DAO governance for the vault, with near-cli-rs (council keys stay in the OS keychain).
//
//   pnpm dao create                      create the DAO on the testnet factory, council = DAO_COUNCIL (2 of 3)
//   pnpm dao handover                    vault proposes the DAO as owner, the council votes accept_owner
//   pnpm dao propose <method> '<json>'   council member 1 files a FunctionCall proposal on the vault
//   pnpm dao approve <id> [n]            council member n (default 1) votes yes; 2 of 3 votes execute it
//   pnpm dao status [id]                 vault owner + last proposals
//
// Facts used (checked against near-daos/sputnik-dao-contract, Nov 2026): DAO = <name>.<factory>; the factory
// `create` takes {name, args: base64({config, policy})}; a council list as policy gives threshold ratio 1/2,
// i.e. 2 votes out of 3; `add_proposal` needs exactly `policy.proposal_bond` attached; `act_proposal` must
// repeat the stored proposal kind; an executed FunctionCall reaches the vault with the DAO as caller.

import { spawnSync } from "node:child_process";

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const FACTORY = process.env.DAO_FACTORY ?? "sputnikv2.testnet";
const vault = process.env.VAULT_ACCOUNT_ID;
const dao = process.env.DAO_ACCOUNT_ID;
const council = (process.env.DAO_COUNCIL ?? "").split(",").filter(Boolean);
if (!vault || !dao || council.length === 0) {
  console.error("Set VAULT_ACCOUNT_ID, DAO_ACCOUNT_ID and DAO_COUNCIL in .env");
  process.exit(1);
}
if (!dao.endsWith(`.${FACTORY}`)) {
  console.error(`DAO_ACCOUNT_ID must be <name>.${FACTORY}`);
  process.exit(1);
}

const q = (s: string) => (process.platform === "win32" ? `"${s.replaceAll('"', '\\"')}"` : s);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");

function near(args: string[], capture = false): string {
  if (!capture) console.log(`\n$ near ${args.join(" ")}`);
  const r = spawnSync("near", args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  if (r.status !== 0) {
    if (capture) console.error(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r.stdout ?? "";
}

const view = <T>(contract: string, method: string, args: object = {}): T =>
  JSON.parse(near(["contract", "call-function", "as-read-only", contract, method, "json-args", q(JSON.stringify(args)), "network-config", NETWORK, "now"], true)) as T;

const call = (contract: string, method: string, args: object, signer: string, deposit = "0 NEAR", gas = "100 Tgas") =>
  near([
    "contract", "call-function", "as-transaction", contract, method, "json-args", q(JSON.stringify(args)),
    "prepaid-gas", q(gas), "attached-deposit", q(deposit), "sign-as", signer, "network-config", NETWORK, "sign-with-keychain", "send",
  ]);

const member = (n: number): string => {
  const m = council[n - 1];
  if (!m) throw new Error(`No council member #${n} (DAO_COUNCIL has ${council.length})`);
  return m;
};

interface Proposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  votes: Record<string, string>;
}

function propose(method: string, args: object, description: string): number {
  const policy = view<{ proposal_bond: string }>(dao!, "get_policy");
  const bondNear = Number(BigInt(policy.proposal_bond) / 10n ** 18n) / 1e6;
  const proposal = {
    description,
    kind: { FunctionCall: { receiver_id: vault, actions: [{ method_name: method, args: b64(args), deposit: "0", gas: "50000000000000" }] } },
  };
  call(dao!, "add_proposal", { proposal }, member(1), `${bondNear} NEAR`);
  const id = view<number>(dao!, "get_last_proposal_id") - 1;
  console.log(`\nProposal #${id} filed by ${member(1)}: ${method}(${JSON.stringify(args)})`);
  return id;
}

function approve(id: number, n: number): void {
  const p = view<Proposal>(dao!, "get_proposal", { id });
  call(dao!, "act_proposal", { id, action: "VoteApprove", proposal: p.kind }, member(n), "0 NEAR", "200 Tgas");
  const after = view<Proposal>(dao!, "get_proposal", { id });
  console.log(`\nProposal #${id}: ${after.status} (${Object.keys(after.votes).length} vote(s))`);
}

function status(id?: number): void {
  const cfg = view<{ owner_id: string; pending_owner_id: string | null; kill_switch: boolean }>(vault!, "get_config");
  console.log(`Vault ${vault}: owner ${cfg.owner_id}${cfg.pending_owner_id ? `, pending ${cfg.pending_owner_id}` : ""}, kill-switch ${cfg.kill_switch ? "ON" : "off"}`);
  const last = view<number>(dao!, "get_last_proposal_id");
  const ids = id !== undefined ? [id] : Array.from({ length: Math.min(last, 5) }, (_, i) => last - 1 - i);
  for (const i of ids) {
    const p = view<Proposal>(dao!, "get_proposal", { id: i });
    console.log(`#${p.id} ${p.status.padEnd(11)} ${p.description}  votes: ${JSON.stringify(p.votes)}`);
  }
}

const [cmd, a1, a2] = process.argv.slice(2);
switch (cmd) {
  case "create": {
    const name = dao.slice(0, -(FACTORY.length + 1));
    const args = { config: { name, purpose: `Owner of the Circuit Breaker vault ${vault}`, metadata: "" }, policy: council };
    call(FACTORY, "create", { name, args: b64(args) }, member(1), process.env.DAO_CREATE_DEPOSIT ?? "6 NEAR", "150 Tgas");
    console.log(`\nDAO ${dao} created, council: ${council.join(", ")}`);
    break;
  }
  case "handover": {
    call(vault, "propose_owner", { new_owner_id: dao }, vault, "0 NEAR", "30 Tgas");
    const id = propose("accept_owner", {}, `Take ownership of the Circuit Breaker vault ${vault}`);
    approve(id, 1);
    approve(id, 2);
    status(id);
    break;
  }
  case "propose":
    if (!a1) throw new Error("usage: pnpm dao propose <method> '<json>' ");
    propose(a1, a2 ? (JSON.parse(a2) as object) : {}, `${a1} on ${vault}`);
    break;
  case "approve":
    if (!a1) throw new Error("usage: pnpm dao approve <id> [member 1-3]");
    approve(Number(a1), Number(a2 ?? 1));
    break;
  case "status":
    status(a1 !== undefined ? Number(a1) : undefined);
    break;
  default:
    console.error("usage: pnpm dao create | handover | propose <method> '<json>' | approve <id> [n] | status [id]");
    process.exit(1);
}
