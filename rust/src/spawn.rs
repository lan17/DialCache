//! Detached task admission.

use futures::future::BoxFuture;

/// Runs detached work the cache does not await: raw source or adapter work
/// that outlives a caller's deadline, and shadow validation jobs.
pub trait Spawner: Send + Sync + 'static {
    /// Start `task` concurrently with the caller.
    fn spawn(&self, task: BoxFuture<'static, ()>);
    /// Start `task` after work that is already runnable has progressed.
    ///
    /// Production runtimes treat this like [`Spawner::spawn`]. A controlled
    /// test executor runs deferred work only once everything else is blocked.
    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.spawn(task)
    }
}

/// Spawns onto the ambient tokio runtime.
#[cfg(feature = "tokio")]
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioSpawner;

#[cfg(feature = "tokio")]
impl Spawner for TokioSpawner {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
}
