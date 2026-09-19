//! Wall and elapsed clocks.

use std::fmt;
use std::sync::{Arc, OnceLock};
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

type MonotonicSource = Arc<dyn Fn() -> Duration + Send + Sync>;
type WallSource = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The default clock: system wall time and a monotonic origin aligned to the
/// process-wide millisecond grid, so default instances share one local expiry grid.
#[derive(Clone)]
pub struct SystemClock {
    monotonic: MonotonicSource,
    wall: WallSource,
    /// Nanoseconds from the monotonic source's zero to this clock's origin.
    origin_ns: u128,
}

impl SystemClock {
    /// System sources: `SystemTime` for wall time and the `Instant` elapsed
    /// since the first default clock of this process for monotonic time.
    pub fn new() -> Self {
        let process = *PROCESS_ORIGIN.get_or_init(Instant::now);
        Self::with_sources(move || process.elapsed(), system_wall_ms)
    }

    /// The production alignment over caller-supplied sources.
    ///
    /// `monotonic` reads elapsed time since one fixed instant shared by every
    /// clock built over it; this clock's origin is the nearest whole
    /// millisecond of that reading at or before construction, so clocks built
    /// at different fractional times share one expiry grid. `wall` supplies
    /// epoch milliseconds. Controlled tests use this to run the default
    /// alignment over a virtual clock.
    pub fn with_sources(
        monotonic: impl Fn() -> Duration + Send + Sync + 'static,
        wall: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Self {
        let since_process = monotonic().as_nanos();
        SystemClock {
            monotonic: Arc::new(monotonic),
            wall: Arc::new(wall),
            origin_ns: grid_origin_ns(since_process),
        }
    }
}

fn system_wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for SystemClock {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SystemClock")
            .field("origin_ns", &self.origin_ns)
            .finish_non_exhaustive()
    }
}

impl Clock for SystemClock {
    fn wall_ms(&self) -> i64 {
        (self.wall)()
    }

    fn elapsed(&self) -> Duration {
        let now_ns = (self.monotonic)().as_nanos();
        Duration::from_nanos(now_ns.saturating_sub(self.origin_ns).min(u64::MAX as u128) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[test]
    fn clocks_built_at_different_fractions_share_one_grid() {
        let now = Arc::new(Mutex::new(Duration::from_micros(700)));
        let source = {
            let now = now.clone();
            move || *now.lock()
        };
        let first = SystemClock::with_sources(source.clone(), || 0);
        *now.lock() = Duration::from_micros(1_300);
        let second = SystemClock::with_sources(source, || 0);
        *now.lock() = Duration::from_micros(1_000_900);
        // Origins are 0 ms and 1 ms: the same grid, one millisecond apart.
        assert_eq!(first.elapsed_ms(), 1_000);
        assert_eq!(second.elapsed_ms(), 999);
        *now.lock() = Duration::from_micros(1_001_000);
        assert_eq!(second.elapsed_ms(), 1_000);
    }

    #[test]
    fn default_clock_is_monotonic_and_shares_the_process_origin() {
        let first = SystemClock::new();
        let second = SystemClock::new();
        let a = first.elapsed();
        assert!(first.elapsed() >= a);
        // Both origins lie on the process grid: whole milliseconds after the
        // process origin, so the two instances share one expiry grid.
        assert_eq!(first.origin_ns % 1_000_000, 0);
        assert_eq!(second.origin_ns % 1_000_000, 0);
        assert!(second.origin_ns >= first.origin_ns);
        assert!(first.wall_ms() > 1_700_000_000_000);
    }
}
