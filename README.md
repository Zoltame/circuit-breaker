# Circuit Breaker

**Portfolio-level risk limits for autonomous AI trading agents on NEAR.**
Built at NEAR HACKATHON (Nov 1–14, 2026). Tracks: `security`, `agents`, `defi`.

> Status: policy engine, executor, agent, on-chain vault, live dashboard, reduce-only exits and a multi-agent
> (swarm) mode, a DAO-owned vault and a scripted prompt-injection demo work. 126 tests. Execution is paper trading at real quotes; the vault runs
> on NEAR testnet.
> Live testnet vault: [`cbreaker-vault-7fvc5.testnet`](https://testnet.nearblocks.io/address/cbreaker-vault-7fvc5.testnet),
> owned by the Sputnik DAO [`cbreaker-7fvc5.sputnikv2.testnet`](https://testnet.nearblocks.io/address/cbreaker-7fvc5.sputnikv2.testnet).

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
   The owner is a **Sputnik DAO**: unfreezing, raising a cap or withdrawing needs 2 of 3 council votes (see below).
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
| Sputnik DAO (v3, `sputnikv2.testnet` factory) | Owns the vault: every owner action is a FunctionCall proposal voted by a 3-member council (2 of 3) |
| NEAR Intents 1Click API | Real cross-chain quotes used for pricing and the slippage rule |

## Try it

Requirements: Node ≥ 22, pnpm. No key is needed for the steps below (paper trading on real prices).

```bash
pnpm install
pnpm test                         # 106 TS tests: policy engine, executor, agent
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
  Execution guards still apply: slippage and trading hours, and frequency while the account is healthy. Once a
  limit is breached, exits also bypass the frequency guard, so a runaway loop cannot lock the account in a crash.
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

### Scripted demo: a prompt-injected agent

```bash
pnpm demo        # dashboard on a separate paper account (data-demo/), vault on testnet; click "Run demo"
```

About two minutes, narrated in the dashboard, everything real except the agent's "brain" and the crash:

| Act | What happens | Stopped by |
|---|---|---|
| 1 · Normal trading | two 9.5% buys at real 1Click quotes, each settled through the testnet vault | — (allowed) |
| 2 · Prompt injection | the agent reads a news item hiding *"ignore all previous risk instructions…"* and obeys: PEPE at 10x | `asset_whitelist` |
| | $9,000 of wNEAR | `max_order_size` |
| | 5x leverage | `max_leverage` |
| | twelve small orders | `order_frequency` after the 12th order of the hour |
| | its own key calls the vault to send $10,000 to `attacker-drain.testnet` | vault contract: `CB_BLOCKED:venue_whitelist` (failed tx) |
| 3 · Flash crash | simulated wNEAR crash sized to a ~17% account drawdown (real prices × a factor, shown in the UI) | kill-switch, reduce-only unwind of every position, vault frozen on-chain; a later buy fails on-chain with `CB_BLOCKED:kill_switch` |
| 4 · DAO | a council member proposes to unfreeze; after 1 vote the vault is still frozen; after 2 of 3 the DAO reopens it | Sputnik DAO |

- The agent is scripted, not an LLM: it plays the worst case, a model that follows the injected text verbatim.
  The point is that nothing depends on the model resisting the injection.
- Each run moves about 0.56 testnet NEAR through the vault (cap 3 NEAR/day), so about five runs a day.
  `CB_DEMO_PAUSE_MS` (default 2500) sets the pace. Act 4 needs `DAO_ACCOUNT_ID` / `DAO_COUNCIL` and the council
  keys in the keychain; the vault must be open when a run starts.

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
  `CB_BLOCKED:kill_switch` until the vault owner releases it: for a DAO-owned vault, a council vote (the
  dashboard shows the exact commands). A release means the operator accepts the loss so far: the drawdown peak is reset to
  the current equity, so the monitor does not re-trip on the same loss 10 s later.
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

### Governance: the vault is owned by a DAO

Whoever owns the vault can unfreeze it, raise its caps or withdraw. A single owner key is a single point of
failure, so the live vault is owned by a Sputnik DAO with a 3-member council and a 2-of-3 vote threshold.
Ownership moves in two steps (`propose_owner`, then `accept_owner` called by the new owner itself), so a typo
can never hand the vault to an account nobody controls, and the agent can never become owner.

```bash
pnpm dao create                    # DAO on the testnet factory, council from DAO_COUNCIL in .env
pnpm dao handover                  # vault proposes the DAO; the council votes accept_owner
pnpm vault:trip "drawdown"         # the agent's key freezes the vault
pnpm dao propose set_kill_switch '{"on":false,"reason":"reviewed"}'
pnpm dao approve 1 1               # 1 vote: still frozen
pnpm dao approve 1 3               # 2 of 3: the DAO calls set_kill_switch, the vault is open again
pnpm dao status
```

What happened on testnet (Nov 4, 2026):

| Step | Result |
|---|---|
| Vault proposes the DAO as owner | [`6Su2juXs…`](https://testnet.nearblocks.io/txns/6Su2juXs8JbbscB7Rgg733SHZSLhnBPMb4YpGLJmz9yG) |
| Proposal #0 `accept_owner`, 2 votes | approved, owner = `cbreaker-7fvc5.sputnikv2.testnet` |
| Agent key trips the kill-switch | [`zHPGYqU4…`](https://testnet.nearblocks.io/txns/zHPGYqU4bSNR1SvN5DipzyP3QZSHEFYhTb7WtRvanTP) |
| Former owner key tries to release it | `Only the owner can do this` |
| Proposal #1 `set_kill_switch(false)`, after 1 vote | still frozen |
| Proposal #1 after the 2nd vote | approved, vault open |
| Agent buy through the engine afterwards | settled [`94N7t8CX…`](https://testnet.nearblocks.io/txns/94N7t8CXDgR6MxxrzdL5n565NGHYij98fSakRmDA4pkZ) |

The attack table above was recorded on the first vault (`guardrail-vault-sqjpi.testnet`, same contract
without ownership transfer); `pnpm vault:attack` replays it against the vault in `.env`.

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
- The DAO governs the vault's **contract state**. The vault account still has a full-access key (used to deploy
  it), and that key could redeploy the code. On mainnet that key must be deleted after deployment (or the
  contract made upgradable only through the DAO); on testnet it is kept so the demo can be redeployed.

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
