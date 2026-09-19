//! Wall and elapsed clocks.

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Separates wall timestamps from monotonic elapsed time.
///
/// Wall time stamps frames and invalidation markers. Elapsed time governs
/// deadlines and process-local expiry. Timers live on the [`Runtime`](crate::Runtime).
pub trait Clock: Send + Sync + 'static {
    /// Epoch milliseconds from the application wall clock.
    fn wall_ms(&self) -> i64;
    /// Monotonic elapsed time since this clock's origin, with native precision.
    fn elapsed(&self) -> Duration;
    /// Whole-millisecond elapsed reading used by process-local storage.
    ///
    /// Insertion and lookup share this integer grid, so an entry inserted at
    /// 0.7 ms with a 1,000 ms TTL expires when this reading reaches 1,000.
    fn elapsed_ms(&self) -> i64 {
        self.elapsed().as_millis().min(i64::MAX as u128) as i64
    }
}

static PROCESS_ORIGIN: OnceLock<Instant> = OnceLock::new();

/// The origin of a clock constructed `now_ns` after the process origin so that
/// its whole-millisecond readings fall on the process-wide grid: the nearest
/// aligned instant at or before construction.
pub fn grid_origin_ns(now_ns: u128) -> u128 {
    now_ns - now_ns % 1_000_000
}

/// The default clock: system wall time and a monotonic origin aligned to the
/// process-wide millisecond grid, so default instances share one local expiry grid.
#[derive(Debug, Clone)]
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        let process = *PROCESS_ORIGIN.get_or_init(Instant::now);
        let now = Instant::now();
        let since_process = now.saturating_duration_since(process).as_nanos();
        let phase = since_process - grid_origin_ns(since_process);
        let origin = now
            .checked_sub(Duration::from_nanos(phase as u64))
            .unwrap_or(now);
        SystemClock { origin }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn wall_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0)
    }

    fn elapsed(&self) -> Duration {
        self.origin.elapsed()
    }
}
