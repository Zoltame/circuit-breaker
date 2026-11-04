//! Circuit Breaker vault: holds an AI agent's trading funds and enforces hard limits on-chain.
//!
//! Roles
//! - owner: configures limits, venues, kill-switch; can withdraw. Usually a DAO (Sputnik), so every
//!   owner action is a proposal voted by its council. Ownership moves in two steps (propose, accept)
//!   so a typo can never hand the vault to an account nobody controls.
//! - agent: holds only a function-call access key scoped to this contract, so it can call
//!   `execute_order` and `trip_kill_switch` and nothing else. It cannot attach deposits, cannot
//!   call other contracts, cannot transfer NEAR. The vault attaches deposits itself when needed.
//!
//! Audit: the agent anchors the head of its hash-chained decision journal here (`anchor_journal`).
//! Anchors are append-only, so a compromised machine cannot rewrite history that was already anchored.
//!
//! These limits hold even if the off-chain policy engine is bypassed or compromised.
//! Rejections panic with `CB_BLOCKED:<rule>: ...`, so they show up as failed transactions.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env, near, require,
};

/// Token key for native NEAR. Any other key is a NEP-141 token contract account id.
pub const NATIVE: &str = "near";
const NS_PER_DAY: u64 = 86_400_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimits {
    pub max_per_order: U128,
    pub max_per_day: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DailyUsage {
    /// UTC day index (block timestamp / 1 day).
    pub day: u64,
    pub spent: U128,
}

#[near(serializers = [json])]
pub struct TokenView {
    pub token: String,
    pub limits: TokenLimits,
    pub spent_today: U128,
    pub remaining_today: U128,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub pending_owner_id: Option<AccountId>,
    pub agent_id: AccountId,
    pub kill_switch: bool,
    pub venues: Vec<AccountId>,
    pub tokens: Vec<TokenView>,
    pub orders_executed: u64,
}

/// Latest anchor of one journal (a journal is identified by the hash of its first entry).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct JournalHead {
    pub anchors: u64,
    pub last_seq: u64,
    pub last_hash: String,
    /// Block timestamp (ns) of the last anchor.
    pub last_at: u64,
}

/// One anchored journal position: entry `seq` of the journal has hash `hash`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub seq: u64,
    pub hash: String,
    pub at: u64,
    pub by: AccountId,
}

/// State layout before journal anchoring, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct VaultV1 {
    owner_id: AccountId,
    agent_id: AccountId,
    kill_switch: bool,
    limits: IterableMap<String, TokenLimits>,
    venues: IterableSet<AccountId>,
    usage: LookupMap<String, DailyUsage>,
    orders_executed: u64,
    pending_owner_id: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    agent_id: AccountId,
    kill_switch: bool,
    limits: IterableMap<String, TokenLimits>,
    venues: IterableSet<AccountId>,
    usage: LookupMap<String, DailyUsage>,
    orders_executed: u64,
    pending_owner_id: Option<AccountId>,
    journals: IterableMap<String, JournalHead>,
    /// Key `<journal_id>#<index>`.
    anchors: LookupMap<String, Anchor>,
}

const MAX_JOURNAL_ID_LEN: usize = 64;

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn blocked(rule: &str, detail: String) -> ! {
    env::panic_str(&format!("CB_BLOCKED:{rule}: {detail}"))
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    let ev = near_sdk::serde_json::json!({
        "standard": "circuit-breaker",
        "version": "1.0.0",
        "event": name,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner_id: AccountId, agent_id: AccountId) -> Self {
        require!(owner_id != agent_id, "The agent cannot own the vault");
        Self {
            owner_id,
            agent_id,
            kill_switch: false,
            limits: IterableMap::new(b"l"),
            venues: IterableSet::new(b"v"),
            usage: LookupMap::new(b"u"),
            orders_executed: 0,
            pending_owner_id: None,
            journals: IterableMap::new(b"j"),
            anchors: LookupMap::new(b"a"),
        }
    }

    /// One-off upgrade from the layout without journal anchoring. Only the contract account can run it,
    /// right after deploying the new code; existing limits, usage and owner are kept as they are.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: VaultV1 = env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"));
        Self {
            owner_id: old.owner_id,
            agent_id: old.agent_id,
            kill_switch: old.kill_switch,
            limits: old.limits,
            venues: old.venues,
            usage: old.usage,
            orders_executed: old.orders_executed,
            pending_owner_id: old.pending_owner_id,
            journals: IterableMap::new(b"j"),
            anchors: LookupMap::new(b"a"),
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn set_token_limits(&mut self, token: String, max_per_order: U128, max_per_day: U128) {
        self.assert_owner();
        require!(max_per_order.0 <= max_per_day.0, "max_per_order must be <= max_per_day");
        self.limits.insert(token.clone(), TokenLimits { max_per_order, max_per_day });
        event("limits_set", near_sdk::serde_json::json!({ "token": token, "max_per_order": max_per_order, "max_per_day": max_per_day }));
    }

    pub fn remove_token(&mut self, token: String) {
        self.assert_owner();
        self.limits.remove(&token);
    }

    pub fn add_venue(&mut self, venue: AccountId) {
        self.assert_owner();
        self.venues.insert(venue);
    }

    pub fn remove_venue(&mut self, venue: AccountId) {
        self.assert_owner();
        self.venues.remove(&venue);
    }

    pub fn set_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        require!(agent_id != self.owner_id, "The agent cannot own the vault");
        self.agent_id = agent_id;
    }

    /// Step 1 of an ownership transfer, e.g. to a DAO. Nothing changes until the new owner accepts.
    /// Proposing again replaces the pending owner; proposing the current owner cancels the transfer.
    pub fn propose_owner(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        require!(new_owner_id != self.agent_id, "The agent cannot own the vault");
        self.pending_owner_id = (new_owner_id != self.owner_id).then_some(new_owner_id);
        event("owner_proposed", near_sdk::serde_json::json!({ "owner": self.owner_id, "pending": self.pending_owner_id }));
    }

    /// Step 2: called by the pending owner itself (for a DAO, through a voted FunctionCall proposal).
    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner_id.as_ref() == Some(&caller), "Only the pending owner can accept");
        let previous = std::mem::replace(&mut self.owner_id, caller);
        self.pending_owner_id = None;
        event("owner_changed", near_sdk::serde_json::json!({ "previous": previous, "owner": self.owner_id }));
    }

    /// Only the owner can release the kill-switch.
    pub fn set_kill_switch(&mut self, on: bool, reason: String) {
        self.assert_owner();
        self.kill_switch = on;
        event("kill_switch", near_sdk::serde_json::json!({ "on": on, "by": env::predecessor_account_id(), "reason": reason }));
    }

    /// Owner-only exit. Not subject to trading limits.
    pub fn withdraw(&mut self, token: String, amount: U128, receiver_id: AccountId) -> Promise {
        self.assert_owner();
        self.send(&token, amount.0, receiver_id, None)
    }

    // ---------------------------------------------------------------- agent

    /// Sends `amount` of `token` to a whitelisted trading venue, within on-chain limits.
    /// With `msg`, NEP-141 tokens go through `ft_transfer_call` (e.g. a deposit into intents.near).
    pub fn execute_order(
        &mut self,
        order_id: String,
        token: String,
        amount: U128,
        venue: AccountId,
        msg: Option<String>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent_id, "Only the agent can execute orders");
        if self.kill_switch {
            blocked("kill_switch", "vault is frozen".into());
        }
        let Some(limits) = self.limits.get(&token).cloned() else {
            blocked("token_whitelist", format!("token {token} is not whitelisted"));
        };
        if !self.venues.contains(&venue) {
            blocked("venue_whitelist", format!("venue {venue} is not whitelisted"));
        }
        require!(amount.0 > 0, "amount must be positive");
        if amount.0 > limits.max_per_order.0 {
            blocked("max_per_order", format!("{} > {}", amount.0, limits.max_per_order.0));
        }
        let today = env::block_timestamp() / NS_PER_DAY;
        let mut usage = self.usage_for(&token, today);
        let after = usage.spent.0.checked_add(amount.0).unwrap_or(u128::MAX);
        if after > limits.max_per_day.0 {
            blocked("max_per_day", format!("{} + {} > {}", usage.spent.0, amount.0, limits.max_per_day.0));
        }

        usage.spent = U128(after);
        self.usage.insert(token.clone(), usage);
        self.orders_executed += 1;
        event(
            "order_executed",
            near_sdk::serde_json::json!({ "order_id": order_id, "token": token, "amount": amount, "venue": venue }),
        );

        self.send(&token, amount.0, venue, msg).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_order_settled(order_id, token, amount, today),
        )
    }

    /// Agent (or owner) can freeze the vault, never unfreeze it: the agent can only tighten.
    pub fn trip_kill_switch(&mut self, reason: String) {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent_id || caller == self.owner_id, "Only the agent or owner can trip");
        self.kill_switch = true;
        event("kill_switch", near_sdk::serde_json::json!({ "on": true, "by": caller, "reason": reason }));
    }

    /// Records that entry `seq` of journal `journal_id` has hash `hash` (SHA-256, hex). Append-only: each
    /// anchor of a journal must be past the previous one. Works while the vault is frozen: the audit trail
    /// matters most then.
    pub fn anchor_journal(&mut self, journal_id: String, seq: u64, hash: String) {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent_id || caller == self.owner_id, "Only the agent or owner can anchor");
        require!(!journal_id.is_empty() && journal_id.len() <= MAX_JOURNAL_ID_LEN, "Invalid journal id");
        require!(is_sha256_hex(&hash), "hash must be 64 lowercase hex chars (SHA-256)");
        let at = env::block_timestamp();
        let head = match self.journals.get(&journal_id) {
            Some(h) => {
                require!(seq > h.last_seq, "Anchors are append-only: seq must be past the last anchored entry");
                JournalHead { anchors: h.anchors + 1, last_seq: seq, last_hash: hash.clone(), last_at: at }
            }
            None => JournalHead { anchors: 1, last_seq: seq, last_hash: hash.clone(), last_at: at },
        };
        self.anchors.insert(format!("{journal_id}#{}", head.anchors - 1), Anchor { seq, hash: hash.clone(), at, by: caller });
        self.journals.insert(journal_id.clone(), head);
        event("journal_anchor", near_sdk::serde_json::json!({ "journal": journal_id, "seq": seq, "hash": hash }));
    }

    // ---------------------------------------------------------------- callbacks

    /// Gives the daily allowance back if the transfer failed.
    #[private]
    pub fn on_order_settled(
        &mut self,
        order_id: String,
        token: String,
        amount: U128,
        day: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        if let Some(mut usage) = self.usage.get(&token).cloned() {
            if usage.day == day {
                usage.spent = U128(usage.spent.0.saturating_sub(amount.0));
                self.usage.insert(token.clone(), usage);
            }
        }
        event("order_failed", near_sdk::serde_json::json!({ "order_id": order_id, "token": token, "amount": amount }));
        false
    }

    /// NEP-141 receiver: accept whitelisted tokens, refund anything else.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = (sender_id, msg);
        let token = env::predecessor_account_id().to_string();
        if self.limits.contains_key(&token) {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        let today = env::block_timestamp() / NS_PER_DAY;
        let tokens = self
            .limits
            .iter()
            .map(|(token, limits)| {
                let spent = self.usage_for(token, today).spent;
                TokenView {
                    token: token.clone(),
                    limits: limits.clone(),
                    spent_today: spent,
                    remaining_today: U128(limits.max_per_day.0.saturating_sub(spent.0)),
                }
            })
            .collect();
        ConfigView {
            owner_id: self.owner_id.clone(),
            pending_owner_id: self.pending_owner_id.clone(),
            agent_id: self.agent_id.clone(),
            kill_switch: self.kill_switch,
            venues: self.venues.iter().cloned().collect(),
            tokens,
            orders_executed: self.orders_executed,
        }
    }

    /// Every journal anchored here, with its latest anchor.
    pub fn get_journals(&self) -> Vec<(String, JournalHead)> {
        self.journals.iter().map(|(id, h)| (id.clone(), h.clone())).collect()
    }

    /// Anchors of one journal, oldest first.
    pub fn get_anchors(&self, journal_id: String, from_index: Option<u64>, limit: Option<u64>) -> Vec<Anchor> {
        let Some(head) = self.journals.get(&journal_id) else { return vec![] };
        let from = from_index.unwrap_or(0);
        let to = head.anchors.min(from.saturating_add(limit.unwrap_or(100)));
        (from..to).filter_map(|i| self.anchors.get(&format!("{journal_id}#{i}")).cloned()).collect()
    }

    pub fn get_usage(&self, token: String) -> DailyUsage {
        self.usage_for(&token, env::block_timestamp() / NS_PER_DAY)
    }

    // ---------------------------------------------------------------- internal

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can do this");
    }

    fn usage_for(&self, token: &str, today: u64) -> DailyUsage {
        match self.usage.get(token) {
            Some(u) if u.day == today => u.clone(),
            _ => DailyUsage { day: today, spent: U128(0) },
        }
    }

    fn send(&self, token: &str, amount: u128, receiver: AccountId, msg: Option<String>) -> Promise {
        if token == NATIVE {
            require!(msg.is_none(), "msg is not supported for native NEAR");
            return Promise::new(receiver).transfer(NearToken::from_yoctonear(amount));
        }
        let token_id: AccountId = token.parse().unwrap_or_else(|_| env::panic_str("invalid token account id"));
        let one_yocto = NearToken::from_yoctonear(1); // required by NEP-141, paid by the vault
        match msg {
            None => Promise::new(token_id).function_call(
                String::from("ft_transfer"),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                    "receiver_id": receiver, "amount": U128(amount)
                }))
                .unwrap(),
                one_yocto,
                GAS_FT_TRANSFER,
            ),
            Some(msg) => Promise::new(token_id).function_call(
                String::from("ft_transfer_call"),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                    "receiver_id": receiver, "amount": U128(amount), "msg": msg
                }))
                .unwrap(),
                one_yocto,
                GAS_FT_TRANSFER_CALL,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    fn agent() -> AccountId {
        "agent.testnet".parse().unwrap()
    }
    fn venue() -> AccountId {
        "venue.testnet".parse().unwrap()
    }

    fn ctx(caller: AccountId, ts_ns: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("vault.testnet".parse().unwrap())
            .predecessor_account_id(caller)
            .block_timestamp(ts_ns)
            .build());
    }

    const DAY1: u64 = 20_000 * NS_PER_DAY + 1;

    fn setup() -> Vault {
        ctx(owner(), DAY1);
        let mut v = Vault::new(owner(), agent());
        v.set_token_limits(NATIVE.into(), U128(100), U128(250));
        v.add_venue(venue());
        v
    }

    fn order(v: &mut Vault, amount: u128) {
        let _ = v.execute_order("o".into(), NATIVE.into(), U128(amount), venue(), None);
    }

    #[test]
    fn executes_within_limits_and_tracks_daily_usage() {
        let mut v = setup();
        ctx(agent(), DAY1);
        order(&mut v, 100);
        order(&mut v, 100);
        assert_eq!(v.get_usage(NATIVE.into()).spent, U128(200));
        assert_eq!(v.get_config().orders_executed, 2);
    }

    #[test]
    #[should_panic(expected = "CB_BLOCKED:max_per_order")]
    fn blocks_order_above_per_order_cap() {
        let mut v = setup();
        ctx(agent(), DAY1);
        order(&mut v, 101);
    }

    #[test]
    #[should_panic(expected = "CB_BLOCKED:max_per_day")]
    fn blocks_order_above_daily_cap() {
        let mut v = setup();
        ctx(agent(), DAY1);
        order(&mut v, 100);
        order(&mut v, 100);
        order(&mut v, 51);
    }

    #[test]
    fn daily_cap_resets_next_day() {
        let mut v = setup();
        ctx(agent(), DAY1);
        order(&mut v, 100);
        order(&mut v, 100);
        ctx(agent(), DAY1 + NS_PER_DAY);
        order(&mut v, 100);
        assert_eq!(v.get_usage(NATIVE.into()).spent, U128(100));
    }

    #[test]
    #[should_panic(expected = "CB_BLOCKED:venue_whitelist")]
    fn blocks_unknown_venue() {
        let mut v = setup();
        ctx(agent(), DAY1);
        let _ = v.execute_order("o".into(), NATIVE.into(), U128(1), "attacker.testnet".parse().unwrap(), None);
    }

    #[test]
    #[should_panic(expected = "CB_BLOCKED:token_whitelist")]
    fn blocks_unknown_token() {
        let mut v = setup();
        ctx(agent(), DAY1);
        let _ = v.execute_order("o".into(), "scam.testnet".into(), U128(1), venue(), None);
    }

    #[test]
    #[should_panic(expected = "CB_BLOCKED:kill_switch")]
    fn agent_can_trip_kill_switch_which_blocks_orders() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.trip_kill_switch("drawdown".into());
        order(&mut v, 1);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_release_kill_switch() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.trip_kill_switch("drawdown".into());
        v.set_kill_switch(false, "let me trade".into());
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_raise_its_own_limits() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.set_token_limits(NATIVE.into(), U128(1_000_000), U128(1_000_000));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_withdraw() {
        let mut v = setup();
        ctx(agent(), DAY1);
        let _ = v.withdraw(NATIVE.into(), U128(1), agent());
    }

    #[test]
    #[should_panic(expected = "Only the agent")]
    fn strangers_cannot_execute() {
        let mut v = setup();
        ctx("stranger.testnet".parse().unwrap(), DAY1);
        order(&mut v, 1);
    }

    #[test]
    fn owner_can_release_kill_switch() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.trip_kill_switch("drawdown".into());
        ctx(owner(), DAY1);
        v.set_kill_switch(false, "reviewed".into());
        ctx(agent(), DAY1);
        order(&mut v, 1);
    }

    fn dao() -> AccountId {
        "council.sputnikv2.testnet".parse().unwrap()
    }

    #[test]
    fn ownership_moves_only_when_the_new_owner_accepts() {
        let mut v = setup();
        v.propose_owner(dao());
        assert_eq!(v.get_config().owner_id, owner()); // nothing changed yet
        ctx(dao(), DAY1);
        v.accept_owner();
        let cfg = v.get_config();
        assert_eq!(cfg.owner_id, dao());
        assert_eq!(cfg.pending_owner_id, None);
        // The DAO now holds every owner power, and the previous owner holds none.
        v.set_kill_switch(true, "council vote".into());
        ctx(owner(), DAY1);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| v.set_kill_switch(false, "old key".into())));
        assert!(res.is_err());
    }

    #[test]
    #[should_panic(expected = "Only the pending owner")]
    fn nobody_else_can_accept_ownership() {
        let mut v = setup();
        v.propose_owner(dao());
        ctx(agent(), DAY1);
        v.accept_owner();
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn agent_cannot_propose_an_owner() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.propose_owner(agent());
    }

    #[test]
    #[should_panic(expected = "The agent cannot own the vault")]
    fn the_agent_can_never_become_owner() {
        let mut v = setup();
        v.propose_owner(agent());
    }

    #[test]
    #[should_panic(expected = "Only the pending owner")]
    fn proposing_the_current_owner_cancels_a_transfer() {
        let mut v = setup();
        v.propose_owner(dao());
        v.propose_owner(owner());
        assert_eq!(v.get_config().pending_owner_id, None);
        ctx(dao(), DAY1);
        v.accept_owner();
    }

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    #[test]
    fn anchors_are_append_only_and_readable() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.anchor_journal("j1".into(), 9, H1.into());
        v.anchor_journal("j1".into(), 19, H2.into());
        let anchors = v.get_anchors("j1".into(), None, None);
        assert_eq!(anchors.iter().map(|a| (a.seq, a.hash.as_str())).collect::<Vec<_>>(), vec![(9, H1), (19, H2)]);
        assert_eq!(anchors[0].by, agent());
        let journals = v.get_journals();
        assert_eq!(journals.len(), 1);
        assert_eq!((journals[0].1.anchors, journals[0].1.last_seq), (2, 19));
        assert!(v.get_anchors("unknown".into(), None, None).is_empty());
    }

    #[test]
    #[should_panic(expected = "append-only")]
    fn cannot_rewrite_an_anchored_position() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.anchor_journal("j1".into(), 9, H1.into());
        v.anchor_journal("j1".into(), 9, H2.into());
    }

    #[test]
    fn anchoring_works_while_frozen() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.trip_kill_switch("drawdown".into());
        v.anchor_journal("j1".into(), 0, H1.into());
        assert_eq!(v.get_anchors("j1".into(), None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the agent or owner can anchor")]
    fn strangers_cannot_anchor() {
        let mut v = setup();
        ctx("stranger.testnet".parse().unwrap(), DAY1);
        v.anchor_journal("j1".into(), 0, H1.into());
    }

    #[test]
    #[should_panic(expected = "SHA-256")]
    fn rejects_a_malformed_hash() {
        let mut v = setup();
        ctx(agent(), DAY1);
        v.anchor_journal("j1".into(), 0, "not-a-hash".into());
    }

    #[test]
    fn migrate_keeps_the_v1_state() {
        let mut v1 = setup();
        ctx(agent(), DAY1);
        order(&mut v1, 100);
        v1.trip_kill_switch("drawdown".into());
        ctx("vault.testnet".parse().unwrap(), DAY1);
        let old = VaultV1 {
            owner_id: v1.owner_id.clone(),
            agent_id: v1.agent_id.clone(),
            kill_switch: v1.kill_switch,
            limits: std::mem::replace(&mut v1.limits, IterableMap::new(b"x")),
            venues: std::mem::replace(&mut v1.venues, IterableSet::new(b"y")),
            usage: std::mem::replace(&mut v1.usage, LookupMap::new(b"z")),
            orders_executed: v1.orders_executed,
            pending_owner_id: None,
        };
        env::state_write(&old);
        drop(old); // store collections write their cached entries on drop, as at the end of a real call
        let mut v2 = Vault::migrate();
        let cfg = v2.get_config();
        assert!(cfg.kill_switch);
        assert_eq!(cfg.orders_executed, 1);
        assert_eq!(cfg.owner_id, owner());
        assert_eq!(cfg.tokens[0].spent_today, U128(100));
        assert_eq!(cfg.venues, vec![venue()]);
        ctx(agent(), DAY1);
        v2.anchor_journal("j1".into(), 0, H1.into());
    }

    #[test]
    fn failed_transfer_gives_daily_allowance_back() {
        let mut v = setup();
        ctx(agent(), DAY1);
        order(&mut v, 100);
        ctx("vault.testnet".parse().unwrap(), DAY1);
        let ok = v.on_order_settled("o".into(), NATIVE.into(), U128(100), DAY1 / NS_PER_DAY, Err(PromiseError::Failed));
        assert!(!ok);
        assert_eq!(v.get_usage(NATIVE.into()).spent, U128(0));
    }

    #[test]
    fn refunds_non_whitelisted_ft_deposits() {
        let mut v = setup();
        ctx("usdc.testnet".parse().unwrap(), DAY1);
        match v.ft_on_transfer(owner(), U128(5), String::new()) {
            PromiseOrValue::Value(r) => assert_eq!(r, U128(5)),
            _ => panic!("expected value"),
        }
    }
}
