// End-to-end on a local sandbox: deploy the vault, then check that the agent can trade within
// limits and that every bypass attempt fails on-chain.

use near_api::{AccountId, NearGas, NearToken};
use near_sdk::serde_json::{Value, json};

async fn create_account(sandbox: &near_sandbox::Sandbox, name: &str, near: u128) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse()?;
    sandbox
        .create_account(account_id.clone())
        .initial_balance(NearToken::from_near(near))
        .send()
        .await?;
    Ok(near_api::Account(account_id))
}

#[tokio::test]
async fn vault_enforces_limits_on_chain() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let owner = create_account(&sandbox, "owner.sandbox", 10).await?;
    let agent = create_account(&sandbox, "agent.sandbox", 10).await?;
    let venue = create_account(&sandbox, "venue.sandbox", 1).await?;
    let attacker = create_account(&sandbox, "attacker.sandbox", 1).await?;
    let vault = create_account(&sandbox, "vault.sandbox", 20).await?.as_contract();

    near_api::Contract::deploy(vault.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({ "owner_id": owner.account_id(), "agent_id": agent.account_id() }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let one = NearToken::from_near(1).as_yoctonear().to_string();
    let two = NearToken::from_near(2).as_yoctonear().to_string();
    let three = NearToken::from_near(3).as_yoctonear().to_string();

    // Owner: max 2 NEAR per order, 3 NEAR per day, one venue.
    for (method, args) in [
        ("set_token_limits", json!({ "token": "near", "max_per_order": two, "max_per_day": three })),
        ("add_venue", json!({ "venue": venue.account_id() })),
    ] {
        vault
            .call_function(method, args)
            .transaction()
            .with_signer(owner.account_id().clone(), signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }

    let call = |method: &'static str, args: Value, who: AccountId| {
        vault
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(100))
            .with_signer(who, signer.clone())
    };
    let order = |amount: &str, to: &AccountId| {
        json!({ "order_id": "t", "token": "near", "amount": amount, "venue": to, "msg": null })
    };

    let venue_before = venue.tokens().near_balance().fetch_from(&net).await?.total;

    // 1. Within limits: 1 NEAR reaches the venue.
    call("execute_order", order(&one, venue.account_id()), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();
    let venue_after = venue.tokens().near_balance().fetch_from(&net).await?.total;
    assert_eq!(venue_after, venue_before.saturating_add(NearToken::from_near(1)));

    // 2. Above the per-order cap.
    call("execute_order", order(&three, venue.account_id()), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // 3. Draining to an attacker-controlled account.
    call("execute_order", order(&one, attacker.account_id()), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // 4. Daily cap: 1 already spent, 2 more is allowed, then 1 more is not.
    call("execute_order", order(&two, venue.account_id()), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();
    call("execute_order", order(&one, venue.account_id()), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // 5. The agent cannot raise its own limits or withdraw.
    call(
        "set_token_limits",
        json!({ "token": "near", "max_per_order": "1000000000000000000000000000", "max_per_day": "1000000000000000000000000000" }),
        agent.account_id().clone(),
    )
    .send_to(&net)
    .await?
    .assert_failure();
    call("withdraw", json!({ "token": "near", "amount": one, "receiver_id": agent.account_id() }), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();

    // 6. The agent can freeze the vault but not unfreeze it.
    call("trip_kill_switch", json!({ "reason": "drawdown" }), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();
    call("set_kill_switch", json!({ "on": false, "reason": "let me trade" }), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();

    let config: Value = vault.call_function("get_config", ()).read_only().fetch_from(&net).await?.data;
    assert_eq!(config["kill_switch"], json!(true));
    assert_eq!(config["orders_executed"], json!(2));
    assert_eq!(config["tokens"][0]["spent_today"], json!(three));

    // 7. Only the owner can release it.
    call("set_kill_switch", json!({ "on": false, "reason": "reviewed" }), owner.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();

    // 8. Ownership moves to a council (a DAO on testnet) in two steps; the old owner then has no power.
    let council = create_account(&sandbox, "council.sandbox", 10).await?;
    call("propose_owner", json!({ "new_owner_id": agent.account_id() }), owner.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();
    call("propose_owner", json!({ "new_owner_id": council.account_id() }), owner.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();
    call("accept_owner", json!({}), agent.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();
    call("accept_owner", json!({}), council.account_id().clone())
        .send_to(&net)
        .await?
        .assert_success();
    call("set_kill_switch", json!({ "on": true, "reason": "old owner" }), owner.account_id().clone())
        .send_to(&net)
        .await?
        .assert_failure();
    let config: Value = vault.call_function("get_config", ()).read_only().fetch_from(&net).await?.data;
    assert_eq!(config["owner_id"], json!(council.account_id()));
    assert_eq!(config["pending_owner_id"], Value::Null);

    Ok(())
}
