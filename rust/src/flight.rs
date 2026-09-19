//! Settle-once cells shared by coalesced callers and detached raw work.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use futures::FutureExt;
use parking_lot::Mutex;

use crate::error::Error;
use crate::local::StoredValue;
use crate::spawn::Spawner;

struct SettledState<T> {
    value: Option<T>,
    wakers: Vec<Waker>,
}

/// A value that is set at most once and observed by any number of waiters.
pub(crate) struct Settled<T> {
    inner: Arc<Mutex<SettledState<T>>>,
}

impl<T> Clone for Settled<T> {
    fn clone(&self) -> Self {
        Settled {
            inner: self.inner.clone(),
        }
    }
}

impl<T: Clone> Settled<T> {
    pub(crate) fn new() -> Self {
        Settled {
            inner: Arc::new(Mutex::new(SettledState {
                value: None,
                wakers: Vec::new(),
            })),
        }
    }

    /// Store the value and wake every waiter. Returns false if already settled.
    pub(crate) fn settle(&self, value: T) -> bool {
        let wakers = {
            let mut state = self.inner.lock();
            if state.value.is_some() {
                return false;
            }
            state.value = Some(value);
            std::mem::take(&mut state.wakers)
        };
        for waker in wakers {
            waker.wake();
        }
        true
    }

    pub(crate) fn peek(&self) -> Option<T> {
        self.inner.lock().value.clone()
    }

    /// A future that completes with a clone of the settled value.
    pub(crate) fn wait(&self) -> Wait<T> {
        Wait {
            settled: self.clone(),
        }
    }
}

pub(crate) struct Wait<T> {
    settled: Settled<T>,
}

impl<T: Clone> Future for Wait<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let mut state = self.settled.inner.lock();
        if let Some(value) = &state.value {
            return Poll::Ready(value.clone());
        }
        if !state.wakers.iter().any(|w| w.will_wake(cx.waker())) {
            state.wakers.push(cx.waker().clone());
        }
        Poll::Pending
    }
}

impl<T> Unpin for Wait<T> {}

/// Describe a panic payload.
pub(crate) fn panic_message(payload: Box<dyn std::any::Any + Send>) -> Arc<str> {
    if let Some(text) = payload.downcast_ref::<&str>() {
        Arc::from(*text)
    } else if let Some(text) = payload.downcast_ref::<String>() {
        Arc::from(text.as_str())
    } else {
        Arc::from("non-string panic payload")
    }
}

/// Start `work` as detached raw work. The returned cell settles with its
/// result, or with `on_panic` when it panics. Callers that stop waiting keep
/// no ownership of the work.
pub(crate) fn start_pending<T, F>(
    spawner: &dyn Spawner,
    work: F,
    on_panic: impl FnOnce(Arc<str>) -> T + Send + 'static,
) -> Settled<T>
where
    T: Clone + Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let settled = Settled::new();
    let cell = settled.clone();
    spawner.spawn(Box::pin(async move {
        let outcome = match AssertUnwindSafe(work).catch_unwind().await {
            Ok(value) => value,
            Err(payload) => on_panic(panic_message(payload)),
        };
        cell.settle(outcome);
    }));
    settled
}

/// Complete once work that is already runnable has progressed (the executor's
/// deferred queue drained under a controlled scheduler).
pub(crate) async fn yield_deferred(spawner: &dyn Spawner) {
    let done: Settled<()> = Settled::new();
    let cell = done.clone();
    spawner.defer(Box::pin(async move {
        cell.settle(());
    }));
    done.wait().await;
}

/// Result of one execution shared by every coalesced caller.
pub(crate) type ValueResult = Result<StoredValue, Error>;

/// One registered execution and its followers.
pub(crate) struct Flight {
    pub(crate) result: Settled<ValueResult>,
    pub(crate) started: Duration,
    pub(crate) followers: AtomicUsize,
}

impl Flight {
    pub(crate) fn new(started: Duration) -> Arc<Self> {
        Arc::new(Flight {
            result: Settled::new(),
            started,
            followers: AtomicUsize::new(0),
        })
    }

    pub(crate) fn join(&self) {
        self.followers.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn followers(&self) -> usize {
        self.followers.load(Ordering::Relaxed)
    }
}
