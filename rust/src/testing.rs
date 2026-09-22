//! Deterministic test doubles: a virtual clock and a single-threaded runtime
//! that runs the cache's detached work to quiescence on demand (feature `test-util`).
//!
//! The cache's detached work and timers go through [`Runtime`], so a
//! single-threaded pool can run every task to quiescence after each command
//! (the `causally-ready-v1` settlement of the formal replay) and deliver timers
//! only when a test advances the clock.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use crate::clock::{Clock, SystemClock};
use crate::runtime::Runtime;
use futures::executor::{LocalPool, LocalSpawner};
use futures::future::BoxFuture;
use futures::task::LocalSpawnExt;
use parking_lot::Mutex;

/// Epoch of every controlled history: 2026-09-08T12:00:00.000Z.
pub const WALL_EPOCH_MS: i64 = 1_788_868_800_000;

impl std::fmt::Debug for VirtualClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VirtualClock")
            .field("wall_ms", &self.wall_ms())
            .field("elapsed", &self.elapsed())
            .finish()
    }
}

struct TimerState {
    at_ns: u128,
    id: u64,
    fired: AtomicBool,
    cancelled: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

struct ClockState {
    wall_ns: i128,
    elapsed_ns: u128,
    scheduler_ns: u128,
    next_timer: u64,
    timers: Vec<Arc<TimerState>>,
}

/// Virtual wall, elapsed and scheduler clocks. Scheduler time is what timers
/// are registered against; it moves only when a history delivers timers, so a
/// silent shift never fires a deliberately held timer.
pub struct VirtualClock {
    state: Mutex<ClockState>,
}

impl VirtualClock {
    /// A clock at `wall_ms` epoch milliseconds with zero elapsed and
    /// scheduler time.
    pub fn new(wall_ms: i64) -> Arc<Self> {
        Arc::new(VirtualClock {
            state: Mutex::new(ClockState {
                wall_ns: wall_ms as i128 * 1_000_000,
                elapsed_ns: 0,
                scheduler_ns: 0,
                next_timer: 0,
                timers: Vec::new(),
            }),
        })
    }

    /// Move wall (and unless `wall_only`, elapsed) time without delivering timers.
    pub fn shift(&self, delta_ms: i64, wall_only: bool) {
        self.shift_ns(delta_ms as i128 * 1_000_000, wall_only);
    }

    /// [`shift`](Self::shift) in nanoseconds; elapsed time saturates at zero.
    pub fn shift_ns(&self, delta_ns: i128, wall_only: bool) {
        let mut state = self.state.lock();
        state.wall_ns += delta_ns;
        if !wall_only {
            state.elapsed_ns = (state.elapsed_ns as i128 + delta_ns).max(0) as u128;
        }
    }

    /// The earliest live timer due at or before `target_ns` scheduler time.
    fn pop_due(&self, target_ns: u128) -> Option<Arc<TimerState>> {
        let mut state = self.state.lock();
        state
            .timers
            .retain(|t| !t.cancelled.load(Ordering::SeqCst) && !t.fired.load(Ordering::SeqCst));
        let mut best: Option<usize> = None;
        for (index, timer) in state.timers.iter().enumerate() {
            if timer.at_ns <= target_ns {
                let better = match best {
                    None => true,
                    Some(current) => {
                        let c = &state.timers[current];
                        timer.at_ns < c.at_ns || (timer.at_ns == c.at_ns && timer.id < c.id)
                    }
                };
                if better {
                    best = Some(index);
                }
            }
        }
        best.map(|index| state.timers.remove(index))
    }

    fn set_scheduler(&self, at_ns: u128) {
        let mut state = self.state.lock();
        let delta = at_ns.saturating_sub(state.scheduler_ns);
        state.wall_ns += delta as i128;
        state.elapsed_ns += delta;
        state.scheduler_ns = at_ns;
    }

    fn scheduler_ns(&self) -> u128 {
        self.state.lock().scheduler_ns
    }

    /// Timers registered and neither fired nor dropped.
    pub fn pending_timers(&self) -> usize {
        let state = self.state.lock();
        state
            .timers
            .iter()
            .filter(|t| !t.cancelled.load(Ordering::SeqCst) && !t.fired.load(Ordering::SeqCst))
            .count()
    }
}

impl Clock for VirtualClock {
    fn wall_ms(&self) -> i64 {
        (self.state.lock().wall_ns.div_euclid(1_000_000)) as i64
    }

    fn elapsed(&self) -> Duration {
        let ns = self.state.lock().elapsed_ns;
        Duration::from_nanos(ns.min(u64::MAX as u128) as u64)
    }
}

impl VirtualClock {
    /// Register a timer against scheduler time.
    pub fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        // A millisecond timer must never shorten a fractional remaining budget:
        // round the delay up to whole milliseconds, as the reference ports do.
        let delay_ns = duration.as_nanos();
        let delay_ms = delay_ns.div_ceil(1_000_000);
        let mut state = self.state.lock();
        state.next_timer += 1;
        let timer = Arc::new(TimerState {
            at_ns: state.scheduler_ns + delay_ms * 1_000_000,
            id: state.next_timer,
            fired: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            waker: Mutex::new(None),
        });
        state.timers.push(timer.clone());
        Box::pin(Sleep { timer })
    }
}

struct Sleep {
    timer: Arc<TimerState>,
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.timer.fired.load(Ordering::SeqCst) {
            return Poll::Ready(());
        }
        *self.timer.waker.lock() = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        self.timer.cancelled.store(true, Ordering::SeqCst);
    }
}

/// Tasks handed to the spawner. Immediate tasks run on the next drain;
/// deferred tasks run only once nothing else is runnable.
#[derive(Default)]
struct Queues {
    immediate: Vec<BoxFuture<'static, ()>>,
    deferred: Vec<BoxFuture<'static, ()>>,
}

/// The test runtime handle: collects tasks for the pool and registers timers
/// on the virtual clock.
pub struct StepRuntime {
    queues: Mutex<Queues>,
    spawned: AtomicU64,
    clock: Arc<VirtualClock>,
}

impl StepRuntime {
    /// A runtime whose timers register on `clock` and whose tasks wait for
    /// a [`TestExecutor`] to drain them.
    pub fn new(clock: Arc<VirtualClock>) -> Arc<Self> {
        Arc::new(StepRuntime {
            queues: Mutex::new(Queues::default()),
            spawned: AtomicU64::new(0),
            clock,
        })
    }

    /// Tasks handed over so far, immediate and deferred.
    pub fn spawned(&self) -> u64 {
        self.spawned.load(Ordering::Relaxed)
    }
}

impl std::fmt::Debug for StepRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StepRuntime")
            .field("spawned", &self.spawned())
            .finish()
    }
}

impl Runtime for StepRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.spawned.fetch_add(1, Ordering::Relaxed);
        self.queues.lock().immediate.push(task);
    }

    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.spawned.fetch_add(1, Ordering::Relaxed);
        self.queues.lock().deferred.push(task);
    }

    fn spawn_blocking(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), crate::BoxError> {
        self.spawn(Box::pin(async move { task() }));
        Ok(())
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        self.clock.sleep(duration)
    }
}

/// The controlled executor of one test: a single-threaded pool plus the
/// clock and runtime handle every cache instance under test shares.
pub struct TestExecutor {
    pool: LocalPool,
    local: LocalSpawner,
    polls: Arc<AtomicU64>,
    /// The virtual clock to share with every instance under test.
    pub clock: Arc<VirtualClock>,
    /// The runtime handle to pass to every instance under test.
    pub runtime: Arc<StepRuntime>,
}

impl std::fmt::Debug for TestExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestExecutor")
            .field("wall_ms", &self.clock.wall_ms())
            .finish()
    }
}

impl TestExecutor {
    /// A fresh pool with its clock at `wall_ms`; replayed histories use
    /// [`WALL_EPOCH_MS`].
    pub fn new(wall_ms: i64) -> Self {
        let pool = LocalPool::new();
        let local = pool.spawner();
        let clock = VirtualClock::new(wall_ms);
        let runtime = StepRuntime::new(clock.clone());
        TestExecutor {
            pool,
            local,
            polls: Arc::new(AtomicU64::new(0)),
            clock,
            runtime,
        }
    }

    /// Actual task polls performed by this executor. A zero-time verification
    /// drain must leave this count unchanged when every task is already blocked.
    pub fn poll_count(&self) -> u64 {
        self.polls.load(Ordering::Relaxed)
    }

    fn tracked<F: Future>(&self, future: F) -> impl Future<Output = F::Output> + use<F> {
        let polls = self.polls.clone();
        let mut future = Box::pin(future);
        futures::future::poll_fn(move |cx| {
            polls.fetch_add(1, Ordering::Relaxed);
            future.as_mut().poll(cx)
        })
    }

    /// Run a future to completion on the pool, draining detached work as it
    /// is spawned. Panics if the future stays blocked once nothing is runnable:
    /// it would be waiting on a gate only the test can release.
    pub fn block_on<R: 'static>(&mut self, future: impl Future<Output = R> + 'static) -> R {
        let slot: std::rc::Rc<std::cell::RefCell<Option<R>>> =
            std::rc::Rc::new(std::cell::RefCell::new(None));
        let sink = slot.clone();
        self.local
            .spawn_local(self.tracked(async move {
                let result = future.await;
                *sink.borrow_mut() = Some(result);
            }))
            .expect("pool accepts tasks");
        self.drain();
        let result = slot.borrow_mut().take();
        result.expect("block_on future stayed blocked on a test-owned gate")
    }

    /// Spawn driver-owned work onto the pool.
    pub fn spawn(&self, task: impl Future<Output = ()> + 'static) {
        self.local
            .spawn_local(self.tracked(task))
            .expect("pool accepts tasks");
    }

    fn move_immediate(&mut self) -> bool {
        let tasks = std::mem::take(&mut self.runtime.queues.lock().immediate);
        let moved = !tasks.is_empty();
        for task in tasks {
            self.local
                .spawn_local(self.tracked(task))
                .expect("pool accepts tasks");
        }
        moved
    }

    fn move_deferred(&mut self) -> bool {
        let tasks = std::mem::take(&mut self.runtime.queues.lock().deferred);
        let moved = !tasks.is_empty();
        for task in tasks {
            self.local
                .spawn_local(self.tracked(task))
                .expect("pool accepts tasks");
        }
        moved
    }

    /// Run until every task is blocked on a gate, an undelivered timer or a
    /// scope gate and nothing is runnable, including deferred work that
    /// becomes runnable once everything else has stalled.
    pub fn drain(&mut self) {
        loop {
            loop {
                self.pool.run_until_stalled();
                if !self.move_immediate() {
                    break;
                }
            }
            if !self.move_deferred() {
                return;
            }
        }
    }

    /// Advance elapsed and wall time by `ms`. With `deliver`, scheduler time
    /// moves too and every timer due on the way fires in order, draining after
    /// each; without it the clocks jump silently.
    pub fn advance(&mut self, ms: i64, deliver: bool) {
        if !deliver {
            self.clock.shift(ms, false);
            self.drain();
            return;
        }
        let target = self.clock.scheduler_ns() + (ms.max(0) as u128) * 1_000_000;
        loop {
            self.drain();
            match self.clock.pop_due(target) {
                Some(timer) => {
                    self.clock.set_scheduler(timer.at_ns);
                    timer.fired.store(true, Ordering::SeqCst);
                    if let Some(waker) = timer.waker.lock().take() {
                        waker.wake();
                    }
                }
                None => {
                    self.clock.set_scheduler(target);
                    break;
                }
            }
        }
        self.drain();
    }

    /// Advance by fractional microseconds without delivering timers (the
    /// local-clock profile's environment ticks).
    pub fn advance_micros(&mut self, micros: i64) {
        self.clock.shift_ns(micros as i128 * 1_000, false);
        self.drain();
    }
}

/// The production [`SystemClock`] built over a [`VirtualClock`].
///
/// Its origin aligns to the shared millisecond grid of the virtual elapsed
/// reading exactly as default instances align to the process grid, so
/// instances constructed at different fractional virtual times share one
/// expiry grid and the default alignment itself is what a controlled history
/// exercises.
pub fn grid_clock(base: &Arc<VirtualClock>) -> SystemClock {
    let monotonic = base.clone();
    let wall = base.clone();
    SystemClock::with_sources(
        move || {
            let ns = monotonic.state.lock().elapsed_ns;
            Duration::from_nanos(ns.min(u64::MAX as u128) as u64)
        },
        move || wall.wall_ms(),
    )
}
