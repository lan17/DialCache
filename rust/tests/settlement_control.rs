//! The no-settle control: a driver that reports the observation held before
//! the settlement drain must fail the observation assertions of every
//! behavior-driver-backed smoke history. It proves the replays depend on the
//! `causally-ready-v1` settlement.

mod formal;

use formal::driver::{install_panic_hook, Driver};
use formal::inventory::repo_path;
use formal::transport::Coordinator;
use serde_json::Value;

const BEHAVIOR_SMOKE: [&str; 13] = [
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
        let mut wall = || cell.borrow().wall_ms();
        coordinator.execute(&prepared, &mut apply, &mut observation, &mut wall, &mut [])
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
            message.contains("expected:") && message.contains("actual:"),
            "{profile}: control failed without comparison evidence: {message}"
        );
    }
    coordinator.finish().expect("coordinator exit");
}
