//! Independent publication checks over driver-owned invocation contexts and
//! actual source/write callbacks. No model predictions or cache internals enter
//! this journal. The runtime decorator preserves context across detached tasks.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use dialcache::Runtime;
use futures::future::BoxFuture;
use serde_json::{json, Value};

thread_local! {
    static INVOCATION: Cell<Option<usize>> = const { Cell::new(None) };
}

pub fn current_invocation() -> Option<usize> {
    INVOCATION.get()
}

struct RestoreInvocation(Option<usize>);

impl Drop for RestoreInvocation {
    fn drop(&mut self) {
        INVOCATION.set(self.0);
    }
}

/// Installs the owner only while polling, so unrelated interleaved tasks never
/// inherit it. Restoration also happens if the wrapped future panics.
pub struct InvocationFuture<F> {
    owner: Option<usize>,
    future: Pin<Box<F>>,
}

impl<F> InvocationFuture<F> {
    pub fn new(owner: Option<usize>, future: F) -> Self {
        Self {
            owner,
            future: Box::pin(future),
        }
    }
}

impl<F: Future> Future for InvocationFuture<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let _restore = RestoreInvocation(INVOCATION.replace(this.owner));
        this.future.as_mut().poll(cx)
    }
}

pub struct InvocationRuntime(pub Arc<dyn Runtime>);

impl Runtime for InvocationRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.0
            .spawn(Box::pin(InvocationFuture::new(current_invocation(), task)));
    }

    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.0
            .defer(Box::pin(InvocationFuture::new(current_invocation(), task)));
    }

    fn spawn_blocking(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), dialcache::BoxError> {
        let owner = current_invocation();
        self.0.spawn_blocking(Box::new(move || {
            let _restore = RestoreInvocation(INVOCATION.replace(owner));
            task();
        }))
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        self.0.sleep(duration)
    }
}

#[derive(Clone, Debug)]
pub enum CausalEvent {
    SourceStart {
        id: usize,
        owner: usize,
        at_ms: i64,
        budget_ms: Option<u64>,
    },
    SourceSettlement {
        id: usize,
        at_ms: i64,
        outcome: &'static str,
    },
    WriteDispatch {
        source: Option<usize>,
        owner: Option<usize>,
        at_ms: i64,
    },
}

/// Only semantically valid journals can reach this discriminator. The mutation
/// measurement independently validates its rule and evidence fields.
pub fn property_failure(rule: &str, condition: &str, mut event: Value) -> String {
    event["condition"] = Value::from(condition);
    format!("CAUSAL_PROPERTY_FAILURE rule={rule} event={event}")
}

/// Necessary C25/C26 conditions; fence and payload provenance still have their
/// separate replay assertions. Pending prefixes and late write completion are
/// allowed when the exact source settled successfully within its own budget.
pub fn assert_publication_causality(history: &[CausalEvent]) -> Result<(), String> {
    struct Source {
        owner: usize,
        started: i64,
        budget: Option<u64>,
        settled: Option<i64>,
        outcome: &'static str,
    }
    let mut sources: HashMap<usize, Source> = HashMap::new();
    let mut owners = HashSet::new();
    let mut previous = -1;
    for (index, event) in history.iter().enumerate() {
        let fail = |reason| format!("C25/C26 causal event {index}: {reason}");
        let at_ms = match *event {
            CausalEvent::SourceStart { at_ms, .. }
            | CausalEvent::SourceSettlement { at_ms, .. }
            | CausalEvent::WriteDispatch { at_ms, .. } => at_ms,
        };
        if at_ms < 0 || at_ms < previous {
            return Err(fail(
                "elapsed observations must be nonnegative and monotonic",
            ));
        }
        previous = at_ms;
        match *event {
            CausalEvent::SourceStart {
                id,
                owner,
                at_ms,
                budget_ms,
            } => {
                if sources.contains_key(&id) || !owners.insert(owner) {
                    return Err(fail("source and invocation ownership must be unique"));
                }
                if budget_ms == Some(0) {
                    return Err(fail(
                        "source budget must be positive or explicitly unbounded",
                    ));
                }
                sources.insert(
                    id,
                    Source {
                        owner,
                        started: at_ms,
                        budget: budget_ms,
                        settled: None,
                        outcome: "",
                    },
                );
            }
            CausalEvent::SourceSettlement { id, at_ms, outcome } => {
                let source = sources
                    .get_mut(&id)
                    .ok_or_else(|| fail("settlement must identify one actual pending source"))?;
                if source.settled.is_some() || !["resolve", "reject"].contains(&outcome) {
                    return Err(fail("settlement must identify one actual pending source"));
                }
                source.settled = Some(at_ms);
                source.outcome = outcome;
            }
            CausalEvent::WriteDispatch { source, owner, .. } => {
                let (Some(id), Some(owner)) = (source, owner) else {
                    return Err(fail("write has no observed source ownership"));
                };
                let source = sources
                    .get(&id)
                    .ok_or_else(|| fail("write has no observed source ownership"))?;
                let evidence = json!({"event":"writeDispatch", "index":index, "atMs":at_ms, "source":id, "owner":owner});
                if source.owner != owner {
                    let mut evidence = evidence;
                    evidence["sourceOwner"] = json!(source.owner);
                    return Err(property_failure(
                        "C26",
                        "write belongs to a different invocation's source",
                        evidence,
                    ));
                }
                if source.outcome != "resolve" {
                    let mut evidence = evidence;
                    evidence["outcome"] = json!(source.outcome);
                    return Err(property_failure(
                        "C26",
                        "write requires that exact source's successful settlement",
                        evidence,
                    ));
                }
                if let Some(budget) = source.budget {
                    let settled = source.settled.expect("resolved source has a settlement");
                    if (settled - source.started) as u64 >= budget {
                        let mut evidence = evidence;
                        evidence["startedAtMs"] = json!(source.started);
                        evidence["settledAtMs"] = json!(settled);
                        evidence["budgetMs"] = json!(budget);
                        return Err(property_failure(
                            "C25",
                            "late raw settlement cannot authorize publication",
                            evidence,
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}
