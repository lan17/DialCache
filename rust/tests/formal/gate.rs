//! A settle-once gate the driver holds and library callbacks await.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use parking_lot::Mutex;

struct GateState<T> {
    value: Option<T>,
    wakers: Vec<Waker>,
}

/// Driver-owned gate: external work blocks on it until the history releases it.
pub struct Gate<T: Clone> {
    inner: Arc<Mutex<GateState<T>>>,
}

impl<T: Clone> Clone for Gate<T> {
    fn clone(&self) -> Self {
        Gate {
            inner: self.inner.clone(),
        }
    }
}

impl<T: Clone> Default for Gate<T> {
    fn default() -> Self {
        Gate::new()
    }
}

impl<T: Clone> Gate<T> {
    pub fn new() -> Self {
        Gate {
            inner: Arc::new(Mutex::new(GateState {
                value: None,
                wakers: Vec::new(),
            })),
        }
    }

    /// Release every waiter with `value`. Returns false if already settled.
    pub fn settle(&self, value: T) -> bool {
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

    pub fn is_settled(&self) -> bool {
        self.inner.lock().value.is_some()
    }

    pub fn wait(&self) -> GateWait<T> {
        GateWait { gate: self.clone() }
    }
}

pub struct GateWait<T: Clone> {
    gate: Gate<T>,
}

impl<T: Clone> Unpin for GateWait<T> {}

impl<T: Clone> Future for GateWait<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let mut state = self.gate.inner.lock();
        if let Some(value) = &state.value {
            return Poll::Ready(value.clone());
        }
        if !state.wakers.iter().any(|w| w.will_wake(cx.waker())) {
            state.wakers.push(cx.waker().clone());
        }
        Poll::Pending
    }
}
