//! Cooperative cancellation for remote reads.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use parking_lot::Mutex;

#[derive(Default)]
struct Inner {
    cancelled: bool,
    wakers: Vec<Waker>,
    callbacks: Vec<Box<dyn FnOnce() + Send>>,
}

/// A cancellation request handed to remote adapters with each read.
///
/// The cache cancels the token once the read deadline passes. Cancellation is
/// a request; it does not prove that a dispatched command stopped.
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.inner.lock().cancelled
    }

    /// Request cancellation once. Later calls do nothing.
    pub fn cancel(&self) {
        let (wakers, callbacks) = {
            let mut inner = self.inner.lock();
            if inner.cancelled {
                return;
            }
            inner.cancelled = true;
            (
                std::mem::take(&mut inner.wakers),
                std::mem::take(&mut inner.callbacks),
            )
        };
        for waker in wakers {
            waker.wake();
        }
        for callback in callbacks {
            callback();
        }
    }

    /// Run `callback` when cancellation is requested, or immediately if it already was.
    pub fn on_cancel(&self, callback: impl FnOnce() + Send + 'static) {
        let mut callback = Some(Box::new(callback) as Box<dyn FnOnce() + Send>);
        {
            let mut inner = self.inner.lock();
            if !inner.cancelled {
                inner
                    .callbacks
                    .push(callback.take().expect("callback present"));
            }
        }
        if let Some(callback) = callback {
            callback();
        }
    }

    /// Completes once cancellation is requested.
    pub fn cancelled(&self) -> Cancelled {
        Cancelled {
            token: self.clone(),
        }
    }
}

/// Future returned by [`CancelToken::cancelled`].
#[derive(Debug)]
pub struct Cancelled {
    token: CancelToken,
}

impl Future for Cancelled {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut inner = self.token.inner.lock();
        if inner.cancelled {
            return Poll::Ready(());
        }
        if !inner.wakers.iter().any(|w| w.will_wake(cx.waker())) {
            inner.wakers.push(cx.waker().clone());
        }
        Poll::Pending
    }
}
