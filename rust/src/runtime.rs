//! Detached task admission and timers.

use std::time::Duration;

use futures::future::BoxFuture;

/// Runs detached work the cache does not await and supplies its timers.
///
/// Detached work is raw source or adapter work that outlives a caller's
/// deadline, and shadow validation jobs. Timers deliver deadlines; a
/// controlled runtime may deliver them on its own schedule.
pub trait Runtime: Send + Sync + 'static {
    /// Start `task` concurrently with the caller.
    fn spawn(&self, task: BoxFuture<'static, ()>);
    /// Start `task` after work that is already runnable has progressed.
    ///
    /// Production runtimes treat this like [`Runtime::spawn`]. A controlled
    /// test runtime runs deferred work only once everything else is blocked.
    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.spawn(task)
    }
    /// A timer that completes once `duration` has passed.
    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()>;
}

/// Spawns onto the ambient tokio runtime and uses tokio timers.
#[cfg(feature = "tokio")]
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioRuntime;

#[cfg(feature = "tokio")]
impl Runtime for TokioRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(duration))
    }
}
