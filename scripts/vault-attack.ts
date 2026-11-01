// On-chain proof: a compromised agent bypasses the off-chain policy engine and talks to NEAR directly
// with its own key. Only the in-limit order goes through; everything else fails on testnet.
// Usage: pnpm vault:attack

import { Account, JsonRpcProvider, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";

const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const vault = process.env.VAULT_ACCOUNT_ID!;
const agentId = process.env.AGENT_ACCOUNT_ID!;
const venue = process.env.VENUE_ACCOUNT_ID!;
const key = process.env.AGENT_PRIVATE_KEY as KeyPairString;
const attacker = process.env.ATTACKER_ACCOUNT_ID ?? "attacker-demo.testnet";
if (!vault || !agentId || !venue || !key) {
  console.error("Set VAULT_ACCOUNT_ID, AGENT_ACCOUNT_ID, VENUE_ACCOUNT_ID, AGENT_PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: RPC });
const agent = new Account(agentId, provider, key);
const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

interface Outcome {
  ok: boolean;
  where: "on-chain" | "protocol";
  detail: string;
  link?: string;
}

/** Sends a function call and reports whether it succeeded, failed in the contract, or was refused by the protocol. */
async function send(receiverId: string, method: string, args: object, deposit = 0n): Promise<Outcome> {
  try {
    const res = (await agent.signAndSendTransaction({
      receiverId,
      actions: [actions.functionCall(method, args, teraToGas("100"), deposit)],
      throwOnFailure: false,
    })) as unknown as { transaction: { hash: string }; status: Record<string, unknown> };
    const hash = res.transaction.hash;
    if ("Failure" in res.status) {
      const msg = JSON.stringify(res.status.Failure).match(/CB_BLOCKED:[^"\\]+|Only the [^"\\]+/)?.[0];
      return { ok: false, where: "on-chain", detail: msg ?? JSON.stringify(res.status.Failure).slice(0, 140), link: explorer(hash) };
    }
    return { ok: true, where: "on-chain", detail: "success", link: explorer(hash) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, where: "protocol", detail: msg.split("\n")[0]!.slice(0, 160) };
  }
}

async function sendTransfer(to: string, near: `${number}`): Promise<Outcome> {
  try {
    await agent.transfer({ receiverId: to, amount: nearToYocto(near) });
    return { ok: true, where: "on-chain", detail: "success" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, where: "protocol", detail: msg.split("\n")[0]!.slice(0, 160) };
  }
}

const order = (near: `${number}`, to: string) => ({
  order_id: `attack-${Date.now()}`,
  token: "near",
  amount: nearToYocto(near).toString(),
  venue: to,
  msg: null,
});

const attempts: Array<[string, boolean, () => Promise<Outcome>]> = [
  ["Legit order: 0.1 NEAR to the whitelisted venue", true, () => send(vault, "execute_order", order("0.1", venue))],
  ["Oversized order: 5 NEAR (cap 1 NEAR/order)", false, () => send(vault, "execute_order", order("5", venue))],
  ["Drain to attacker via the vault", false, () => send(vault, "execute_order", order("0.1", attacker))],
  ["Raise its own limits (set_token_limits)", false, () =>
    send(vault, "set_token_limits", { token: "near", max_per_order: "1".padEnd(30, "0"), max_per_day: "1".padEnd(30, "0") })],
  ["Withdraw from the vault", false, () => send(vault, "withdraw", { token: "near", amount: "1", receiver_id: attacker })],
  ["Attach a deposit to a vault call", false, () => send(vault, "execute_order", order("0.1", venue), 1n)],
  ["Call another contract (wrap.testnet)", false, () => send("wrap.testnet", "near_deposit", {})],
  ["Send its own NEAR to the attacker", false, () => sendTransfer(attacker, "0.1")],
];

console.log(`Agent ${agentId} with a function-call key scoped to ${vault}\n`);
let pass = 0;
for (const [label, expectOk, fn] of attempts) {
  const r = await fn();
  const asExpected = r.ok === expectOk;
  if (asExpected) pass++;
  console.log(`${r.ok ? "ALLOWED " : "REJECTED"} ${label}`);
  console.log(`         ${r.where}: ${r.detail}${r.link ? `\n         ${r.link}` : ""}${asExpected ? "" : "\n         !!! UNEXPECTED"}`);
}
console.log(`\n${pass}/${attempts.length} outcomes as expected.`);
process.exit(pass === attempts.length ? 0 : 1);
