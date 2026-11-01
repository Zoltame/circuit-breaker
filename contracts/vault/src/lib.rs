//! Circuit Breaker vault: holds an AI agent's trading funds and enforces hard limits on-chain.
//!
//! Roles
//! - owner: configures limits, venues, kill-switch; can withdraw.
//! - agent: holds only a function-call access key scoped to this contract, so it can call
//!   `execute_order` and `trip_kill_switch` and nothing else. It cannot attach deposits, cannot
//!   call other contracts, cannot transfer NEAR. The vault attaches deposits itself when needed.
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
    pub agent_id: AccountId,
    pub kill_switch: bool,
    pub venues: Vec<AccountId>,
    pub tokens: Vec<TokenView>,
    pub orders_executed: u64,
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
        Self {
            owner_id,
            agent_id,
            kill_switch: false,
            limits: IterableMap::new(b"l"),
            venues: IterableSet::new(b"v"),
            usage: LookupMap::new(b"u"),
            orders_executed: 0,
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
        self.agent_id = agent_id;
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
            agent_id: self.agent_id.clone(),
            kill_switch: self.kill_switch,
            venues: self.venues.iter().cloned().collect(),
            tokens,
            orders_executed: self.orders_executed,
        }
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
