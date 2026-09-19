//! JSON-lines client for the shared Node replay coordinator.
//!
//! Ports `replayCoordinator` from `go/replay_coordinator_test.go`: one request
//! per line on the child's stdin, one reply per line on its stdout, a strictly
//! increasing request id, exact envelope checks and a real-time watchdog that
//! kills a child which leaves a request pending longer than the timeout.
//!
//! The coordinator is `node <repo>/formal/replay/coordinator.mjs`, started with
//! the `node` found on `PATH`. **It must be Node 24** (the shared replay code
//! relies on it); when running these tests on a machine whose default `node`
//! is another major version, prepend the Node 24 `bin` directory to `PATH`
//! (for example `/opt/homebrew/opt/node@24/bin`) before invoking `cargo test`.
//! Node is test tooling only; the cache library itself has no Node dependency.
//!
//! Everything here is synchronous (`std::process`, `std::io`, threads). The
//! watchdog observes real process time only; replay IO never consumes a driver
//! deadline or releases a cache gate.

use super::json::{sorted_keys, strict_parse};
use super::schema::{safe_index, Schema, OBSERVATION_DEFINITIONS};
use serde_json::{Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The settlement contract every observe request declares.
pub const SETTLEMENT: &str = "causally-ready-v1";

/// Largest reply frame the transport buffers.
pub const FRAME_LIMIT: usize = 64 * 1024 * 1024;

/// Default real-time bound on one coordinator round trip.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Repository-relative location of the shared coordinator program.
pub const COORDINATOR_PATH: &str = "formal/replay/coordinator.mjs";

/// Absolute path of `formal/replay/coordinator.mjs`, resolved from this crate's manifest.
pub fn coordinator_program() -> Result<PathBuf, String> {
    let relative = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(COORDINATOR_PATH);
    std::path::absolute(&relative).map_err(|error| format!("{}: {error}", relative.display()))
}

/// A validated `prepare` result: the coordinator's session for one history.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    /// Session identifier for the following `observe`/`discard` requests.
    pub session: String,
    /// Number of steps, including the initial observation at index 0.
    pub steps: i64,
    /// `$defs` definition every observation of this session must satisfy.
    pub observation: String,
    /// Initialization fixture for the native driver (an object).
    pub fixture: Value,
    /// Commands to apply before the first observation.
    pub setup: Vec<Value>,
    /// Action name of every step; the first is always `init`.
    pub actions: Vec<String>,
}

/// One running coordinator process and its JSON-lines connection.
pub struct Coordinator {
    schema: Schema,
    child: Arc<Mutex<Child>>,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
    stderr: Option<JoinHandle<Vec<u8>>>,
    watchdog: Option<JoinHandle<()>>,
    pending: Arc<Mutex<Option<Instant>>>,
    stopped: Arc<AtomicBool>,
    sequence: i64,
    expect_process_failure: bool,
    finished: bool,
}

impl std::fmt::Debug for Coordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Coordinator")
            .field("sequence", &self.sequence)
            .field("finished", &self.finished)
            .finish_non_exhaustive()
    }
}

impl Coordinator {
    /// Starts the shared coordinator (`node formal/replay/coordinator.mjs`)
    /// with the default 30 s request timeout.
    pub fn spawn() -> Result<Coordinator, String> {
        let mut command = Command::new("node");
        command.arg(coordinator_program()?);
        Coordinator::start(command, DEFAULT_TIMEOUT, false)
    }

    /// Starts an arbitrary child as the coordinator. Test controls substitute
    /// a broken transport this way without replacing any cache implementation;
    /// `expect_process_failure` silences the exit-status check in [`finish`].
    ///
    /// [`finish`]: Coordinator::finish
    pub fn start(
        mut command: Command,
        timeout: Duration,
        expect_process_failure: bool,
    ) -> Result<Coordinator, String> {
        let schema = Schema::load()?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("cannot start replay coordinator: {error}"))?;
        let input = child.stdin.take().ok_or("coordinator stdin unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("coordinator stdout unavailable")?;
        let mut errors = child
            .stderr
            .take()
            .ok_or("coordinator stderr unavailable")?;
        let stderr = std::thread::spawn(move || {
            let mut captured = Vec::new();
            let _ = errors.read_to_end(&mut captured);
            captured
        });
        let child = Arc::new(Mutex::new(child));
        let pending: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let stopped = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let (child, pending, stopped) = (
                Arc::clone(&child),
                Arc::clone(&pending),
                Arc::clone(&stopped),
            );
            std::thread::spawn(move || {
                while !stopped.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(10));
                    let expired = pending
                        .lock()
                        .map(|since| since.is_some_and(|since| since.elapsed() > timeout))
                        .unwrap_or(false);
                    if expired {
                        if let Ok(mut child) = child.lock() {
                            let _ = child.kill();
                        }
                        return;
                    }
                }
            })
        };
        Ok(Coordinator {
            schema,
            child,
            input: Some(input),
            output: BufReader::new(output),
            stderr: Some(stderr),
            watchdog: Some(watchdog),
            pending,
            stopped,
            sequence: 0,
            expect_process_failure,
            finished: false,
        })
    }

    /// The protocol schema this transport validates against.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    fn arm(&self, since: Option<Instant>) {
        if let Ok(mut pending) = self.pending.lock() {
            *pending = since;
        }
    }

    /// Sends one request, adding `version: 1` and the next id, and returns the
    /// validated `result` object of a successful reply.
    pub fn call(&mut self, mut request: Map<String, Value>) -> Result<Value, String> {
        self.sequence += 1;
        request.insert("version".to_string(), Value::from(1));
        request.insert("id".to_string(), Value::from(self.sequence));
        let mut raw =
            serde_json::to_vec(&Value::Object(request)).map_err(|error| error.to_string())?;
        raw.push(b'\n');
        self.arm(Some(Instant::now()));
        let exchanged = self.exchange(&raw);
        self.arm(None);
        let line = exchanged?;
        let text = std::str::from_utf8(&line)
            .map_err(|_| "coordinator response is not UTF-8".to_string())?;
        let envelope = match strict_parse(text)? {
            Value::Object(envelope) => envelope,
            _ => return Err("malformed coordinator envelope".to_string()),
        };
        let ok = match envelope.get("ok") {
            Some(Value::Bool(ok)) => *ok,
            Some(_) => return Err("malformed coordinator envelope".to_string()),
            None => false,
        };
        let keys = sorted_keys(&envelope);
        if (ok && keys != "id,ok,result,version") || (!ok && keys != "error,id,ok,version") {
            return Err("malformed coordinator envelope".to_string());
        }
        if !safe_index(envelope.get("version"), 1) || !safe_index(envelope.get("id"), 1) {
            return Err("malformed coordinator envelope".to_string());
        }
        let version = envelope
            .get("version")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let id = envelope.get("id").and_then(Value::as_f64).unwrap_or(0.0);
        if version != 1.0 || id != self.sequence as f64 {
            return Err("unknown or out-of-sequence coordinator response".to_string());
        }
        if !ok {
            return match envelope.get("error") {
                Some(Value::String(message)) if !message.is_empty() => {
                    Err(format!("shared replay: {message}"))
                }
                _ => Err("malformed coordinator failure".to_string()),
            };
        }
        match envelope.get("result") {
            Some(Value::Object(_)) => Ok(envelope.get("result").cloned().unwrap_or(Value::Null)),
            _ => Err("malformed coordinator success".to_string()),
        }
    }

    fn exchange(&mut self, raw: &[u8]) -> Result<Vec<u8>, String> {
        let input = self
            .input
            .as_mut()
            .ok_or("coordinator input already closed")?;
        input
            .write_all(raw)
            .and_then(|()| input.flush())
            .map_err(|error| format!("coordinator write failed: {error}"))?;
        read_frame(&mut self.output, FRAME_LIMIT).map_err(|error| {
            format!("coordinator unavailable or exceeded real-time request limit: {error}")
        })
    }

    /// Prepares one history and validates the coordinator's session description.
    pub fn prepare(
        &mut self,
        profile: &str,
        path: &Path,
        raw: Option<&str>,
    ) -> Result<Prepared, String> {
        let absolute =
            std::path::absolute(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut request = Map::new();
        request.insert("op".to_string(), Value::from("prepare"));
        request.insert("profile".to_string(), Value::from(profile));
        request.insert(
            "path".to_string(),
            Value::from(absolute.to_string_lossy().into_owned()),
        );
        if let Some(raw) = raw {
            request.insert("raw".to_string(), Value::from(raw));
        }
        let result = self.call(request)?;
        let result = result.as_object().ok_or("malformed replay preparation")?;
        let session = result.get("session").and_then(Value::as_str).unwrap_or("");
        if sorted_keys(result) != "actions,fixture,observation,session,settlement,setup,steps"
            || result.get("settlement").and_then(Value::as_str) != Some(SETTLEMENT)
            || session.is_empty()
            || !safe_index(result.get("steps"), 2)
        {
            return Err("malformed replay preparation".to_string());
        }
        let definition = result
            .get("observation")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !OBSERVATION_DEFINITIONS.contains(&definition)
            || self.schema.definition(definition).is_none()
        {
            return Err(format!(
                "malformed replay observation definition {definition:?}"
            ));
        }
        let fixture = match result.get("fixture") {
            Some(fixture @ Value::Object(_)) => fixture.clone(),
            _ => return Err("malformed replay fixture".to_string()),
        };
        let setup = match result.get("setup") {
            Some(Value::Array(setup)) if self.schema.commands_valid(setup) => setup.clone(),
            _ => return Err("malformed replay setup".to_string()),
        };
        let steps = result.get("steps").and_then(Value::as_f64).unwrap_or(0.0) as i64;
        let actions = match result.get("actions") {
            Some(Value::Array(actions)) if actions.len() as i64 == steps => actions,
            _ => return Err("malformed replay actions".to_string()),
        };
        let mut names = Vec::with_capacity(actions.len());
        for (index, action) in actions.iter().enumerate() {
            let name = action.as_str().unwrap_or("");
            if name.is_empty() || (index == 0) != (name == "init") {
                return Err("malformed replay action".to_string());
            }
            names.push(name.to_string());
        }
        Ok(Prepared {
            session: session.to_string(),
            steps,
            observation: definition.to_string(),
            fixture,
            setup,
            actions: names,
        })
    }

    /// Replays one prepared history through a driver: applies setup, then for
    /// every step runs the monitors, validates the observation locally, sends
    /// it and applies the returned commands until the coordinator completes the
    /// session. Any early exit discards the coordinator session.
    pub fn execute(
        &mut self,
        prepared: &Prepared,
        apply: &mut dyn FnMut(&Value) -> Result<(), String>,
        observation: &mut dyn FnMut() -> Value,
        wall_ms: &mut dyn FnMut() -> i64,
        monitors: &mut [&mut dyn FnMut() -> Result<(), String>],
    ) -> Result<(), String> {
        let outcome = self.run(prepared, apply, observation, wall_ms, monitors);
        if outcome.is_err() {
            let mut request = Map::new();
            request.insert("op".to_string(), Value::from("discard"));
            request.insert(
                "session".to_string(),
                Value::from(prepared.session.as_str()),
            );
            let _ = self.call(request);
        }
        outcome
    }

    fn run(
        &mut self,
        prepared: &Prepared,
        apply: &mut dyn FnMut(&Value) -> Result<(), String>,
        observation: &mut dyn FnMut() -> Value,
        wall_ms: &mut dyn FnMut() -> i64,
        monitors: &mut [&mut dyn FnMut() -> Result<(), String>],
    ) -> Result<(), String> {
        for input in &prepared.setup {
            apply(input)?;
        }
        for index in 0..prepared.steps {
            for monitor in monitors.iter_mut() {
                monitor()?;
            }
            // A malformed record is a driver defect. Attribute it here, before
            // the coordinator sees it, so no round trip or session state is
            // spent on it.
            let observed = observation();
            self.schema
                .observation_error(&observed, &prepared.observation)?;
            let mut environment = Map::new();
            environment.insert("wallMs".to_string(), Value::from(wall_ms()));
            let mut request = Map::new();
            request.insert("op".to_string(), Value::from("observe"));
            request.insert(
                "session".to_string(),
                Value::from(prepared.session.as_str()),
            );
            request.insert("index".to_string(), Value::from(index));
            request.insert("settlement".to_string(), Value::from(SETTLEMENT));
            request.insert("observed".to_string(), observed);
            request.insert("environment".to_string(), Value::Object(environment));
            let result = self.call(request)?;
            let result = result.as_object().ok_or("malformed next replay command")?;
            let next = index + 1;
            if result.get("complete") == Some(&Value::Bool(true)) {
                let steps = result.get("steps");
                if sorted_keys(result) != "complete,steps"
                    || next != prepared.steps
                    || !safe_index(steps, 2)
                    || steps.and_then(Value::as_f64) != Some(next as f64)
                {
                    return Err("premature or malformed replay completion".to_string());
                }
                return Ok(());
            }
            let inputs = result.get("inputs").and_then(Value::as_array);
            if sorted_keys(result) != "complete,index,inputs"
                || result.get("complete") != Some(&Value::Bool(false))
                || !safe_index(result.get("index"), 1)
                || result.get("index").and_then(Value::as_f64) != Some(next as f64)
                || !inputs
                    .is_some_and(|inputs| !inputs.is_empty() && self.schema.commands_valid(inputs))
            {
                return Err("malformed next replay command".to_string());
            }
            for input in inputs.unwrap_or(&Vec::new()) {
                apply(input)?;
            }
        }
        Err("replay ended without completion".to_string())
    }

    /// Closes the child's stdin, waits for it to exit and reports a failed exit
    /// (with its captured stderr) unless the process was expected to fail. The
    /// watchdog stays armed while closing so a child that ignores EOF cannot
    /// hang the suite.
    pub fn finish(mut self) -> Result<(), String> {
        self.close()
    }

    fn close(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        self.arm(Some(Instant::now()));
        drop(self.input.take());
        // Poll instead of blocking in wait() so the watchdog can take the child
        // handle and kill a process that ignores EOF.
        let status = loop {
            let polled = match self.child.lock() {
                Ok(mut child) => child.try_wait().map_err(|error| error.to_string()),
                Err(_) => Err("coordinator handle poisoned".to_string()),
            };
            match polled {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => break Err(error),
            }
        };
        self.stopped.store(true, Ordering::SeqCst);
        self.arm(None);
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
        let stderr = self
            .stderr
            .take()
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        let status = status?;
        if !status.success() && !self.expect_process_failure {
            return Err(format!(
                "shared replay process failed: {status}\n{}",
                String::from_utf8_lossy(&stderr)
            ));
        }
        Ok(())
    }
}

impl Drop for Coordinator {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// Reads one newline-terminated frame, failing with `oversized coordinator
/// response` before buffering more than `limit` bytes. The reader's own buffer
/// bounds each fragment, so an unbounded line never accumulates in memory.
pub fn read_frame<R: BufRead>(reader: &mut R, limit: usize) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    loop {
        let (fragment, done) = {
            let available = reader.fill_buf().map_err(|error| error.to_string())?;
            if available.is_empty() {
                return Err("coordinator closed its output before completing a frame".to_string());
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(at) => (available[..=at].to_vec(), true),
                None => (available.to_vec(), false),
            }
        };
        if line.len() + fragment.len() > limit {
            return Err("oversized coordinator response".to_string());
        }
        reader.consume(fragment.len());
        line.extend_from_slice(&fragment);
        if done {
            return Ok(line);
        }
    }
}
