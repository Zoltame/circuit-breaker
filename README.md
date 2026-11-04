# Circuit Breaker

**Portfolio-level risk limits for autonomous AI trading agents on NEAR.**
Built at NEAR HACKATHON (Nov 1–14, 2026). Tracks: `security`, `agents`, `defi`.

> Status: policy engine, executor, agent, on-chain vault, live dashboard, reduce-only exits and a multi-agent
> (swarm) mode work. 100 tests. Execution is paper trading at real quotes; the vault runs on NEAR testnet.
> Live testnet vault: [`guardrail-vault-sqjpi.testnet`](https://testnet.nearblocks.io/address/guardrail-vault-sqjpi.testnet).

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
   off-chain engine is bypassed or compromised. With `--onchain`, every allowed buy must also
   settle through the vault on NEAR testnet before it is filled.
5. Every decision is logged and shown on a **live dashboard** with a kill-switch button.
   Tripping it also freezes the vault on-chain; only the vault owner can unfreeze it.
6. **Breaches never lock the account into a loss.** Once the kill-switch, the daily loss limit or the
   drawdown limit is hit, orders that only *sell* a held position still go through (reduce-only), and a
   drawdown breach unwinds every position by itself, even if the agent stops trading (see below).
7. Optional **swarm mode**: several agents share one account, each with its own budget and its own drawdown
   limit; a failing agent is quarantined without stopping the others (see below).

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
pnpm test                         # 100 TS tests: policy engine, executor, agent
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

### Reduce-only exits and auto-flatten

A risk desk that blocks every order after a loss limit has locked itself into the losing position.
Circuit Breaker separates *adding* risk from *removing* it:

| Account state | Buy | Sell of a held position |
|---|---|---|
| Normal | rules 1–10 | rules 1–10 |
| Kill-switch on, daily loss or drawdown limit hit | blocked | **allowed** (reduce-only) |

- A sale counts as an exit only if it sells part or all of a **spot position that is actually held**, without
  leverage, and never more than the position. Anything else is treated like any other order.
- For an exit, rules 1 (kill-switch), 2 (whitelist, a held asset can always be sold), 3 (order size), 6 (daily
  loss) and 7 (drawdown) are waived and the waiver is written to the journal (`waived: [...]`).
  Execution guards still apply: frequency, slippage and trading hours.
- `autoFlatten: true` (default): when the drawdown limit trips the kill-switch, every position is sold with
  those reduce-only exits. A monitor checks the account every 10 s (agent loop and dashboard), so a breach is
  handled even if the agent proposes nothing. If an exit fails (bad quote), it is retried after 60 s.
- The monitor does nothing when a held asset has no price: a price-feed outage must not look like a crash.
- `Flatten all` in the dashboard (or `breaker.flatten()`) sells everything without touching the kill-switch.

### Swarm mode (several agents, one risk desk)

Use `policies/swarm.yaml` (`pnpm dashboard:swarm`) or add a `swarm:` section to a policy:

```yaml
swarm:
  agents:
    momentum-1: { budgetPct: 30, maxDrawdownPct: 8 }
    meanrev-1:  { budgetPct: 30, maxDrawdownPct: 8 }
```

- Each agent gets a **budget** (max gross exposure, % of account equity) and its **own drawdown limit**.
  An agent that is not listed is refused. An agent can only sell what its own book holds.
- Each agent has a book (units, average cost, realised PnL). Its equity is its allocation plus its PnL.
- An agent that falls `maxDrawdownPct` below its own peak is **quarantined**: buys are refused, exits are
  allowed, and its positions are unwound. The other agents keep trading and the account kill-switch stays off.
  The operator releases it from the dashboard (its peak is reset, so it does not re-trip on the old loss).
- The account-level rules still apply to the sum of all agents.
- Start a swarm from a fresh account (`--data data-swarm` is used by `pnpm dashboard:swarm`).

### Live dashboard

```bash
pnpm dashboard                     # http://localhost:8787, paper only, no key needed
pnpm dashboard --onchain --agent   # buys settle through the testnet vault; momentum agent runs every 10 s
```

- **Red team** panel: each button attacks the system and the result appears in the decision feed.
  - *Oversized order* → `BLOCK max_order_size`
  - *Token outside the whitelist* → `BLOCK asset_whitelist`
  - *5x leverage* → `BLOCK max_leverage`
  - *Runaway loop (15 orders)* → 10 filled, then `BLOCK order_frequency` (limit 12/hour)
  - *Unlisted agent* / *keeps buying past its own budget* (swarm policy only) → `BLOCK agent_budget`
  - *Skip the engine* (needs `--onchain`) → the agent's key calls the vault directly for $10,000 →
    `VAULT BLOCK CB_BLOCKED:max_per_order`, with a link to the failed transaction on testnet
- **Trip kill-switch** → status turns red, every order is blocked with `kill_switch`, and the vault is
  frozen on-chain. **Release (off-chain)** re-opens the engine, but buys still fail with
  `CB_BLOCKED:kill_switch` until the vault owner releases it with their own key (the dashboard shows the
  exact `near` command).
- Gauges: equity and PnL, drawdown from peak, daily loss, orders in the last hour, exposure per asset,
  each against its policy limit. The vault card reads `get_config` from the contract.

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

## What the vault does not know (limits)

- The vault is **on-chain and unbypassable**, but it is blind to PnL: it enforces per-order and per-day
  **amount caps**, a token whitelist, a venue whitelist and a kill-switch. Drawdown, exposure per asset,
  leverage, slippage and the per-agent budgets are enforced **off-chain** by the policy engine.
- If the off-chain engine were bypassed, the agent could still trade up to the vault caps each day, but could
  not exceed them, withdraw, attach a deposit or call another contract (see the attack table above).
- A function-call key cannot attach a deposit, which is why funds sit in a vault contract rather than directly
  in an agent account. NEAR Intents has no testnet: executions are paper fills at real `dry: true` quotes.
- The vault does not (yet) support transferring ownership, so its owner is a regular account, not a DAO.

## Repository layout

```
policies/            risk policies (default, swarm) + JSON schema
packages/
  policy-engine/     pure, deterministic evaluation of the 10 rules + tests
  agent/             momentum agent; can only propose intents
  executor/          CircuitBreaker gate, 1Click dry quotes, paper broker, JSONL journal
  dashboard/         server (SSE, kill-switch, red team) + static UI
contracts/vault/     on-chain vault (Rust, near-sdk) + tests
scripts/             propose, agent, vault deploy/attack, 1Click spike
docs/                notes and architecture
```

## Libraries

near-sdk (Rust), near-sandbox, near-api (Rust tests), cargo-near, near-api-js, NEAR Intents 1Click REST API, zod (policy validation + JSON schema), yaml, vitest, tsx,
TypeScript. Full list in `package.json` files.

## License

MIT — see [LICENSE](LICENSE).
