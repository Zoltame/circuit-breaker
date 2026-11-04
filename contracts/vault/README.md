# Circuit Breaker vault

NEAR smart contract (Rust, near-sdk 5.29) that holds an AI agent's trading funds and enforces hard
limits on-chain. It is layer 2 of Circuit Breaker: it keeps holding if the off-chain policy engine
is bypassed or compromised.

## Roles

| Role | Can | Cannot |
|---|---|---|
| owner (a Sputnik DAO on testnet) | set per-token caps, whitelist venues, set/release kill-switch, withdraw, change agent, propose a new owner | make the agent owner |
| pending owner | `accept_owner` (step 2 of a transfer) | anything else until it accepts |
| agent | `execute_order` within caps to a whitelisted venue, `trip_kill_switch`, `anchor_journal` | release the kill-switch, change caps, withdraw, rewrite an anchor, anything else |

The agent account holds **only a function-call access key** with
`receiver_id = <vault>` and `method_names = [execute_order, trip_kill_switch, anchor_journal]`. NEAR itself then refuses,
before the contract runs: calls to other methods or contracts, attached deposits, NEAR transfers,
key management. The vault attaches the NEP-141 1 yoctoNEAR itself when it moves tokens.

Limits of that key (NEAR protocol): its `allowance` covers gas only and the key is unusable once
spent; an account that has only function-call keys cannot transfer NEAR or add keys.

## Ownership transfer (e.g. to a DAO)

1. The owner calls `propose_owner(new_owner_id)`. Nothing changes yet; proposing the current owner cancels it.
2. The new owner calls `accept_owner()` itself. For a Sputnik DAO that is a FunctionCall proposal voted by its
   council: the vault sees the DAO as caller.

Two steps mean a mistyped account can never receive the vault. `get_config` shows `owner_id` and
`pending_owner_id`. The agent can be neither owner nor pending owner.

## Journal anchors

`anchor_journal(journal_id, seq, hash)` (agent or owner) records that entry `seq` of the off-chain decision
journal `journal_id` has SHA-256 `hash` (64 lowercase hex chars). Anchors of a journal are append-only: `seq`
must be past the last anchored entry, so an anchored position can never be overwritten. It works while the
vault is frozen and emits a `journal_anchor` event. Views: `get_journals()` (each journal with its latest
anchor) and `get_anchors(journal_id, from_index?, limit?)`, oldest first. `pnpm journal:verify` compares a
journal file with them.

The state layout gained two collections for this; `migrate()` (private, `#[init(ignore_state)]`) upgraded the
live vault in place, keeping owner, caps, usage and kill-switch.

## Checks in `execute_order` (first failure panics with `CB_BLOCKED:<rule>`)

1. caller is the agent
2. `kill_switch` is off
3. token is whitelisted (`near` = native NEAR, otherwise a NEP-141 contract id)
4. venue is whitelisted
5. `amount <= max_per_order`
6. spent today + amount `<= max_per_day` (UTC day; given back if the transfer fails)

With `msg`, NEP-141 tokens are sent with `ft_transfer_call` (e.g. a deposit into `intents.near` on
mainnet); without it, `ft_transfer`. Native NEAR uses a plain transfer.

## Build and test (Docker, any OS)

```bash
pnpm contract test    # 19 unit tests + sandbox integration test
pnpm contract build   # -> contracts/vault/out/vault.wasm
```

## Deploy on testnet and try to break it

```bash
pnpm vault:deploy 1 3   # deploy, cap 1 NEAR/order and 3 NEAR/day, new agent key -> .env
pnpm vault:attack       # 1 legit order succeeds, 7 bypass attempts fail (on-chain or by the protocol)
```
