# Circuit Breaker

**Portfolio-level risk limits for autonomous AI trading agents on NEAR.**
Built at NEAR HACKATHON (Nov 1–14, 2026). Tracks: `security`, `agents`, `defi`.

> Status: day 1 of 14 — policy engine, executor and agent work (paper trading on real quotes).
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
   off-chain engine is bypassed or compromised. _(planned)_
5. Every decision is logged and shown on a **live dashboard** with a kill-switch button. _(planned)_

## How NEAR is used

| NEAR feature | Role |
|---|---|
| Function-call access keys | Agent can call only the vault's trading methods, cannot attach deposits, cannot touch other contracts |
| Smart contract (Rust, near-sdk) | Vault enforcing per-order / per-day caps, token whitelist and kill-switch on-chain _(planned)_ |
| NEAR Intents 1Click API | Real cross-chain quotes used for pricing and the slippage rule |

## Try it

Requirements: Node ≥ 22, pnpm. No key is needed for the steps below (paper trading on real prices).

```bash
pnpm install
pnpm test                         # 49 tests: policy engine, executor, agent
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

### Day-1 spikes

```bash
cp .env.example .env    # fill in the NEAR testnet values
pnpm spike:1click       # real NEAR Intents quote, nothing is signed or sent
pnpm spike:near         # what a function-call key can and cannot do on testnet
```

- `pnpm spike:1click` → prints the number of supported tokens and a dry quote for 1 wNEAR → USDC
  (`amountOut`, `minAmountOut`, USD values). Works without any key.
- `pnpm spike:near` → with an agent account holding a function-call key scoped to
  `guestbook.near-examples.testnet` / `add_message`, prints:
  `ALLOWED` for the in-scope call, `REJECTED` for the same call with a 1 yoctoNEAR deposit,
  `REJECTED` for a call to another contract.

## Repository layout

```
policies/            risk policy config + JSON schema
packages/
  policy-engine/     pure, deterministic evaluation of the 10 rules + tests
  agent/             momentum agent; can only propose intents
  executor/          CircuitBreaker gate, 1Click dry quotes, paper broker, JSONL journal
                     (vault calls planned)
  dashboard/         live UI                                       (planned)
contracts/           vault contract (Rust)                         (planned)
scripts/             spikes and the scripted demo
docs/                notes and architecture
```

## Libraries

near-api-js, NEAR Intents 1Click REST API, zod (policy validation + JSON schema), yaml, vitest, tsx,
TypeScript. Full list in `package.json` files.

## License

MIT — see [LICENSE](LICENSE).
