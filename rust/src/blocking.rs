//! Bounded CPU dispatch shared by production runtimes.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, OnceLock};

use futures::channel::oneshot;
use parking_lot::Mutex;

use crate::error::BoxError;
use crate::execution::PanicError;
use crate::flight::{panic_message, DROPPED_MESSAGE};
use crate::runtime::Runtime;

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Pool {
    sender: mpsc::SyncSender<Job>,
}

impl Pool {
    fn new(workers: usize, queued: usize) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(queued);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..workers {
            let receiver = receiver.clone();
            std::thread::Builder::new()
                .name(format!("dialcache-cpu-{index}"))
                .spawn(move || loop {
                    let next = receiver.lock().recv();
                    let Ok(job) = next else { break };
                    // A custom job must not take a worker out of the pool.
                    let _ = catch_unwind(AssertUnwindSafe(job));
                })?;
        }
        Ok(Self { sender })
    }

    fn submit(&self, job: Job) -> Result<(), BoxError> {
        self.sender
            .try_send(job)
            .map_err(|_| "DialCache CPU queue is full or unavailable".into())
    }
}

pub(crate) fn submit(job: Job) -> Result<(), BoxError> {
    static POOL: OnceLock<Result<Pool, String>> = OnceLock::new();
    POOL.get_or_init(|| Pool::new(2, 2).map_err(|e| e.to_string()))
        .as_ref()
        .map_err(|e| -> BoxError { format!("Could not start DialCache CPU workers: {e}").into() })?
        .submit(job)
}

/// Waiting does not own or cancel the admitted raw job. Its closure owns its
/// payload and any shadow slot until it finishes, even if the runtime closes.
pub(crate) async fn run<T: Send + 'static>(
    runtime: &dyn Runtime,
    job: impl FnOnce() -> Result<T, BoxError> + Send + 'static,
) -> Result<T, BoxError> {
    let (send, receive) = oneshot::channel();
    catch_unwind(AssertUnwindSafe(|| {
        runtime.spawn_blocking(Box::new(move || {
            let result = catch_unwind(AssertUnwindSafe(job))
                .unwrap_or_else(|p| Err(Box::new(PanicError(panic_message(p)))));
            let _ = send.send(result);
        }))
    }))
    .map_err(|p| -> BoxError { Box::new(PanicError(panic_message(p))) })??;
    receive
        .await
        .map_err(|_| -> BoxError { DROPPED_MESSAGE.into() })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn pool_bounds_admission_and_keeps_worker_after_panic() {
        let pool = Pool::new(1, 1).unwrap();
        let (started, running) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        pool.submit(Box::new(move || {
            started.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(5)).unwrap();
            panic!("worker must survive");
        }))
        .unwrap();
        running.recv_timeout(Duration::from_secs(5)).unwrap();
        let (finished, done) = mpsc::channel();
        pool.submit(Box::new(move || {
            finished.send(()).unwrap();
        }))
        .unwrap();
        assert!(pool
            .submit(Box::new(|| panic!("rejected task ran")))
            .is_err());
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
