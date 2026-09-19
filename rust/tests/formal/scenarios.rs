//! Fixed behavioral scenarios: handwritten command/expectation sequences
//! replayed through the behavior driver.

use serde_json::{Map, Value};

use super::driver::{empty_observation, Driver};
use super::inventory::repo_path;
use super::json::{json_equal, strict_parse};

/// Load and validate `formal/behavioral-scenarios.json`.
pub fn load_scenarios() -> Result<Vec<Value>, String> {
    let text = std::fs::read_to_string(repo_path("formal/behavioral-scenarios.json"))
        .map_err(|e| e.to_string())?;
    let corpus = strict_parse(&text)?;
    if corpus.get("schemaVersion").and_then(Value::as_i64) != Some(2) {
        return Err("unsupported behavioral schema".to_string());
    }
    let scenarios = corpus
        .get("scenarios")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if scenarios.is_empty() {
        return Err("empty behavioral corpus".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    let shape = empty_observation(&serde_json::json!({ "observe": [] }));
    for scenario in &scenarios {
        let name = scenario.get("name").and_then(Value::as_str).unwrap_or("");
        let steps = scenario
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if name.is_empty() || !seen.insert(name.to_string()) || steps.is_empty() {
            return Err(format!("invalid/duplicate/empty scenario {name:?}"));
        }
        for step in &steps {
            if !step.get("input").is_some_and(Value::is_object) {
                return Err(format!("missing input in {name}"));
            }
            let Some(patch) = step.get("expect").and_then(Value::as_object) else {
                return Err(format!("missing expected patch in {name}"));
            };
            for key in patch.keys() {
                if !shape.contains_key(key) {
                    return Err(format!("unknown expected field {key}"));
                }
            }
        }
    }
    Ok(scenarios)
}

/// Replay one scenario; every step's observation must equal the accumulated expectation.
pub fn replay_scenario(scenario: &Value) -> Result<(), String> {
    let fixture = scenario.get("fixture").cloned().unwrap_or(Value::Null);
    let name = scenario.get("name").and_then(Value::as_str).unwrap_or("");
    let mut driver = Driver::new(fixture.clone());
    let mut expected: Map<String, Value> = empty_observation(&fixture);
    let result = (|| {
        for (index, step) in scenario
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(patch) = step.get("expect").and_then(Value::as_object) {
                for (key, value) in patch {
                    expected.insert(key.clone(), value.clone());
                }
            }
            let input = step.get("input").cloned().unwrap_or(Value::Null);
            driver
                .apply(&input)
                .map_err(|e| format!("{name} step {index} input {input}: {e}"))?;
            let actual = driver.observation();
            let expected_value = Value::Object(expected.clone());
            if !json_equal(&expected_value, &actual) {
                return Err(format!("{name} step {index} input {input}\nexpected: {expected_value}\nactual:   {actual}"));
            }
        }
        Ok(())
    })();
    driver.close();
    result
}
