//! The no-settle control: skipping the driver drain must fail the settlement
//! contract of every behavior smoke history before observation comparison.

mod formal;

use formal::driver::{install_panic_hook, Driver};
use formal::inventory::repo_path;
use formal::transport::Coordinator;
use serde_json::{json, Value};

const BEHAVIOR_SMOKE: [&str; 15] = [
    "dark-layers",
    "shadow-read-deadlines",
    "effects",
    "admission",
    "independent",
    "layers",
    "local-failure",
    "policy",
    "recovery",
    "recovery-read",
    "runtime-boundaries",
    "scope",
    "shadow",
    "shadow-layers",
    "source-budgets",
];

fn replay(coordinator: &mut Coordinator, profile: &str, skip_settle: bool) -> Result<(), String> {
    let path = repo_path(&format!(
        "formal/{}-smoke.itf.json",
        if profile == "effects" {
            "effects"
        } else {
            profile
        }
    ));
    let prepared = coordinator.prepare(profile, &path, None)?;
    let mut driver = Driver::new(prepared.fixture.clone());
    driver.skip_settle = skip_settle;
    let result = {
        let cell = std::cell::RefCell::new(&mut driver);
        let mut apply = |input: &Value| cell.borrow_mut().apply(input);
        let mut observation = || cell.borrow().observation();
        let mut wall = || cell.borrow().observation_wall_ms();
        let mut receipt = || cell.borrow().receipt();
        coordinator.execute(
            &prepared,
            &mut apply,
            &mut observation,
            &mut wall,
            Some(&mut receipt),
            &mut [],
        )
    };
    driver.close();
    result
}

#[test]
fn unsettled_observations_fail_every_behavior_smoke_history() {
    install_panic_hook();
    let mut coordinator = Coordinator::spawn().expect("coordinator");
    for profile in BEHAVIOR_SMOKE {
        replay(&mut coordinator, profile, false)
            .unwrap_or_else(|e| panic!("{profile} settled replay must pass: {e}"));
        let unsettled = replay(&mut coordinator, profile, true);
        assert!(
            unsettled.is_err(),
            "{profile}: an unsettled observation was accepted"
        );
        let message = unsettled.unwrap_err();
        assert!(
            message.contains("Settlement violation:")
                && !message.contains("expected:")
                && !message.contains("actual:"),
            "{profile}: control did not fail its own settlement contract: {message}"
        );
    }
    coordinator.finish().expect("coordinator exit");
}

#[test]
fn receipt_detects_runnable_work_without_observation_changes() {
    let mut driver = Driver::new(json!({}));
    let before = driver.observation();
    let clock = driver.observation_wall_ms();
    let finished = std::rc::Rc::new(std::cell::Cell::new(false));
    let flag = finished.clone();
    driver.exec.spawn(async move { flag.set(true) });
    driver.skip_settle = true;
    driver
        .apply(&json!({"op":"faults", "value":{}}))
        .expect("command");
    assert!(finished.get(), "verification drain must run ready work");
    assert_eq!(driver.observation(), before, "work has no observed effects");
    assert_eq!(
        driver.observation_wall_ms(),
        clock,
        "draining must consume no time"
    );
    assert!(
        driver.receipt()["runnable"].as_u64().unwrap() > 0,
        "the receipt must detect actual polls even when observations and timers do not change"
    );
    driver.close();
}
