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

/// Spawns onto one tokio runtime, captured as a handle at construction, and
/// uses that runtime's timers.
///
/// The default instance is [`TokioRuntime::current`], taken while the cache is
/// built; [`DialCacheBuilder::build`](crate::DialCacheBuilder::build) fails
/// with a configuration error outside a tokio context instead of panicking on
/// first use. The runtime must have its time driver enabled (tokio's
/// `enable_time` or `enable_all`), or the first deadline panics inside the
/// detached work and surfaces as [`Error::Panic`](crate::Error::Panic).
#[cfg(feature = "tokio")]
#[derive(Debug, Clone)]
pub struct TokioRuntime {
    handle: tokio::runtime::Handle,
}

#[cfg(feature = "tokio")]
impl TokioRuntime {
    /// The runtime of the current tokio context.
    pub fn current() -> Result<Self, crate::error::ConfigError> {
        tokio::runtime::Handle::try_current()
            .map(Self::from_handle)
            .map_err(|_| {
                crate::error::ConfigError::invalid(
                    "DialCache requires a tokio runtime: build the cache inside one, or \
                     configure DialCacheBuilder::runtime with TokioRuntime::from_handle",
                )
            })
    }

    /// Use the runtime behind `handle`, whichever context later calls the cache.
    pub fn from_handle(handle: tokio::runtime::Handle) -> Self {
        TokioRuntime { handle }
    }
}

#[cfg(feature = "tokio")]
impl Runtime for TokioRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.handle.spawn(task);
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        // Enter the captured runtime so the timer binds to its time driver
        // rather than to whichever runtime happens to call the cache.
        let _enter = self.handle.enter();
        Box::pin(tokio::time::sleep(duration))
    }
}
