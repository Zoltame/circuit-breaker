# Circuit Breaker

**Portfolio-level risk limits for autonomous AI trading agents on NEAR.**
Built at NEAR HACKATHON (Nov 1–14, 2026). Tracks: `security`, `agents`, `defi`.

> Status: day 1 of 14 — policy engine, executor, agent and on-chain vault work.
> Live testnet vault: [`guardrail-vault-sqjpi.testnet`](https://testnet.nearblocks.io/address/guardrail-vault-sqjpi.testnet).
> Sections marked _(planned)_ are not built yet.

## The problem

Giving an AI agent a wallet gives it too much power. Existing agent-wallet controls on NEAR
(OutLayer agent custody, the NEAR Intents Agent API, NEAR Intents SHIELD) cap **flows**:
amount per transaction, per day, per USD budget, allowed destinations, a freeze switch.
None of them reason about the **portfolio**: how much of the capital sits in one asset,
how far the account is from its peak (drawdown), leverage, or how bad a quote's slippage is.
A trading desk would never run a trader with flow caps only.

## What Circuit Breaker does

1. The agent **proposes** an order.
2. A deterministic **policy engine** checks it against institutional-style risk rules
   (kill-switch, asset whitelist, max order size, max exposure per asset, max leverage,
   daily loss limit, max drawdown → automatic kill-switch, order frequency, max slippage,
   trading hours) and returns `allow` or `block` with the rule and the observed values.
3. Allowed orders are priced with **real NEAR Intents 1Click quotes** (`dry: true`, mainnet prices,
   no funds moved) and executed.
4. Funds sit in an **on-chain vault contract** (NEAR testnet). The agent only holds a
   **function-call access key** scoped to that vault, so on-chain caps still hold if the
   off-chain engine is bypassed or compromised. The vault contract is deployed on testnet;
   wiring the paper executor to it is _(planned)_.
5. Every decision is logged and shown on a **live dashboard** with a kill-switch button. _(planned)_

## How NEAR is used

| NEAR feature | Role |
|---|---|
| Function-call access keys | Agent can call only the vault's trading methods, cannot attach deposits, cannot touch other contracts |
| Smart contract (Rust, near-sdk) | Vault enforcing per-order / per-day caps, token and venue whitelists and a kill-switch the agent can trip but never release |
| NEAR Intents 1Click API | Real cross-chain quotes used for pricing and the slippage rule |

## Try it

Requirements: Node ≥ 22, pnpm. No key is needed for the steps below (paper trading on real prices).

```bash
pnpm install
pnpm test                         # 49 TS tests: policy engine, executor, agent
pnpm propose buy wNEAR 500        # allowed: priced by a real 1Click dry quote, paper-filled
pnpm propose buy wNEAR 2500       # blocked: max_order_size (25% of equity > 10%)
pnpm propose buy SCAM 100         # blocked: asset_whitelist
pnpm propose buy wNEAR 300 3      # blocked: max_leverage (3x > 1x)
pnpm agent 30 10                  # momentum agent, 30 ticks every 10 s, live prices
```

- Each `propose` prints the decision record: `verdict`, `triggeredRule`, `reason`, `observed`, `limit`,
  the quote used (`amountInUsd` / `amountOutUsd`) and the paper fill.
- Every decision is appended to `data/decisions.jsonl`; the paper account lives in `data/state.json`
  (starts at 10,000 USDC). Delete `data/` to reset.
- Blocked orders never reach the quote service or the broker.
- Policy: [`policies/default.yaml`](policies/default.yaml), validated against [`policies/schema.json`](policies/schema.json).

### On-chain proof: a compromised agent cannot exceed the vault's limits

The agent account `guardrail-agent-sqjpi.testnet` holds a single function-call key scoped to the
vault (`execute_order`, `trip_kill_switch`). `pnpm vault:attack` uses that key to talk to NEAR directly,
skipping the policy engine, as a prompt-injected or compromised agent would:

| Attempt | Result | Enforced by |
|---|---|---|
| 0.1 NEAR order to the whitelisted venue | succeeds | — |
| 5 NEAR order (cap 1 NEAR/order) | `CB_BLOCKED:max_per_order` | vault contract (failed tx on-chain) |
| 0.1 NEAR order to an attacker account | `CB_BLOCKED:venue_whitelist` | vault contract (failed tx on-chain) |
| raise its own limits, withdraw | `Access key does not allow method …` | NEAR protocol |
| attach a deposit | `Deposit is not allowed with function call` | NEAR protocol |
| call another contract | `Access key receiver … does not match` | NEAR protocol |
| send its own NEAR away | `Access key requires full access` | NEAR protocol |

To reproduce with your own testnet accounts: fill `.env` from `.env.example`, then
`pnpm contract build`, `pnpm vault:deploy 1 3`, `pnpm vault:attack` (needs Docker and near-cli-rs).
Contract details: [`contracts/vault/README.md`](contracts/vault/README.md).

### Real NEAR Intents quote

```bash
pnpm spike:1click       # 1 wNEAR -> USDC dry quote, nothing is signed or sent, no key needed
```

## Repository layout

```
policies/            risk policy config + JSON schema
packages/
  policy-engine/     pure, deterministic evaluation of the 10 rules + tests
  agent/             momentum agent; can only propose intents
  executor/          CircuitBreaker gate, 1Click dry quotes, paper broker, JSONL journal
  dashboard/         live UI                                       (planned)
contracts/vault/     on-chain vault (Rust, near-sdk) + tests
scripts/             propose, agent, vault deploy/attack, 1Click spike
docs/                notes and architecture
```

## Libraries

near-sdk (Rust), near-sandbox, near-api (Rust tests), cargo-near, near-api-js, NEAR Intents 1Click REST API, zod (policy validation + JSON schema), yaml, vitest, tsx,
TypeScript. Full list in `package.json` files.

## License

MIT — see [LICENSE](LICENSE).
