// J1 spike: prove what a function-call access key can and cannot do on testnet.
// The agent key was added with:
//   receiver = guestbook.near-examples.testnet, methods = [add_message], allowance = 0.25 NEAR (gas only)
// Expected: 1) allowed call succeeds  2) same call + 1 yocto deposit fails  3) other contract fails.

import { Account, JsonRpcProvider, type KeyPairString, teraToGas } from "near-api-js";

const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const AGENT = process.env.AGENT_ACCOUNT_ID;
const KEY = process.env.AGENT_PRIVATE_KEY as KeyPairString | undefined;
const GUESTBOOK = "guestbook.near-examples.testnet";

if (!AGENT || !KEY) {
  console.error("Set AGENT_ACCOUNT_ID and AGENT_PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: RPC });
const agent = new Account(AGENT, provider, KEY);

async function attempt(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`ALLOWED  ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`REJECTED ${label}\n         -> ${msg.split("\n")[0]?.slice(0, 160)}`);
  }
}

async function main(): Promise<void> {
  const total = await provider.callFunction({ contractId: GUESTBOOK, method: "total_messages", args: {} });
  console.log(`view ${GUESTBOOK}.total_messages = ${String(total)}\n`);

  await attempt("add_message, no deposit (in scope)", () =>
    agent.callFunction({
      contractId: GUESTBOOK,
      methodName: "add_message",
      args: { text: "circuit-breaker J1 spike: scoped function-call key" },
      gas: teraToGas("30"),
    }),
  );

  await attempt("add_message + 1 yoctoNEAR deposit", () =>
    agent.callFunction({
      contractId: GUESTBOOK,
      methodName: "add_message",
      args: { text: "should not land" },
      gas: teraToGas("30"),
      deposit: 1n,
    }),
  );

  await attempt("call a different contract (wrap.testnet.near_deposit)", () =>
    agent.callFunction({
      contractId: "wrap.testnet",
      methodName: "near_deposit",
      args: {},
      gas: teraToGas("30"),
    }),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
