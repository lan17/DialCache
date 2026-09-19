//! JSONL assertion report of one Rust conformance run.
//!
//! The Node completion adapter reads this file to credit each inventory id, so
//! every record is one JSON object per line: a `start` header, one `case` per
//! required id, and a `finish` footer with the totals. The path comes from
//! `DIALCACHE_RUST_REPORT`; without it the writer is a no-op that still counts.

use serde_json::{json, Map, Value};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Current wall time in epoch milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Totals of one run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Summary {
    /// Cases reported.
    pub cases: u64,
    /// Cases that failed.
    pub failed: u64,
}

impl Summary {
    /// `passed` when nothing failed, otherwise `failed`.
    pub fn status(&self) -> &'static str {
        if self.failed == 0 {
            "passed"
        } else {
            "failed"
        }
    }
}

/// JSONL report writer.
pub struct Report {
    output: Option<BufWriter<File>>,
    summary: Summary,
    failures: Vec<(String, String)>,
}

impl std::fmt::Debug for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Report")
            .field("enabled", &self.output.is_some())
            .field("summary", &self.summary)
            .finish()
    }
}

impl Report {
    /// Creates the report at `DIALCACHE_RUST_REPORT`, or a counting no-op when unset.
    pub fn from_env() -> Result<Report, String> {
        let path = std::env::var("DIALCACHE_RUST_REPORT")
            .ok()
            .filter(|value| !value.is_empty());
        Report::create(path.as_deref().map(Path::new))
    }

    /// Creates (truncates) the report file, or a counting no-op for `None`.
    pub fn create(path: Option<&Path>) -> Result<Report, String> {
        let output = match path {
            Some(path) => Some(BufWriter::new(
                File::create(path).map_err(|error| format!("{}: {error}", path.display()))?,
            )),
            None => None,
        };
        Ok(Report {
            output,
            summary: Summary::default(),
            failures: Vec::new(),
        })
    }

    /// Whether records are written anywhere.
    pub fn enabled(&self) -> bool {
        self.output.is_some()
    }

    fn write(&mut self, record: Value) -> Result<(), String> {
        if let Some(output) = self.output.as_mut() {
            serde_json::to_writer(&mut *output, &record).map_err(|error| error.to_string())?;
            output.write_all(b"\n").map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// Writes the `start` header.
    pub fn start(&mut self) -> Result<(), String> {
        self.write(json!({"schemaVersion": 1, "kind": "start", "implementation": "rust", "startedAt": now_ms()}))
    }

    /// Records one case with its outcome and timestamps.
    pub fn case(
        &mut self,
        id: &str,
        result: &Result<(), String>,
        started_ms: i64,
        finished_ms: i64,
    ) -> Result<(), String> {
        self.summary.cases += 1;
        let mut record = Map::new();
        record.insert("kind".to_string(), Value::from("case"));
        record.insert("id".to_string(), Value::from(id));
        record.insert(
            "status".to_string(),
            Value::from(if result.is_ok() { "passed" } else { "failed" }),
        );
        record.insert("startedAt".to_string(), Value::from(started_ms));
        record.insert("finishedAt".to_string(), Value::from(finished_ms));
        if let Err(message) = result {
            self.summary.failed += 1;
            self.failures.push((id.to_string(), message.clone()));
            record.insert("message".to_string(), Value::from(message.as_str()));
        }
        self.write(Value::Object(record))
    }

    /// Runs `body` as one timed case and records it.
    pub fn run_case(
        &mut self,
        id: &str,
        body: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let started = now_ms();
        let result = body();
        let finished = now_ms();
        self.case(id, &result, started, finished)?;
        result
    }

    /// Totals so far.
    pub fn summary(&self) -> Summary {
        self.summary
    }

    /// Writes the `finish` footer, flushes, and prints a human summary.
    pub fn finish(&mut self) -> Result<Summary, String> {
        let summary = self.summary;
        self.write(json!({
            "kind": "finish",
            "status": summary.status(),
            "finishedAt": now_ms(),
            "cases": summary.cases,
            "failed": summary.failed,
        }))?;
        if let Some(output) = self.output.as_mut() {
            output.flush().map_err(|error| error.to_string())?;
        }
        for (id, message) in &self.failures {
            println!("FAILED {id}: {message}");
        }
        println!(
            "rust conformance: {} cases, {} failed, status {}",
            summary.cases,
            summary.failed,
            summary.status()
        );
        Ok(summary)
    }
}
