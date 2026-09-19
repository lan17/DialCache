//! Monotonic deadlines over controlled clocks.

use std::time::Duration;

use futures::future::{select, Either};

use crate::clock::Clock;
use crate::flight::Settled;

/// Elapsed time since `start`, never negative.
pub(crate) fn since(clock: &dyn Clock, start: Duration) -> Duration {
    clock.elapsed().saturating_sub(start)
}

pub(crate) fn seconds_since(clock: &dyn Clock, start: Duration) -> f64 {
    since(clock, start).as_secs_f64()
}

/// Wait for `pending`, accepting only a result observed strictly before the
/// deadline `started + budget_ms`. Raw work keeps its resources after the
/// caller stops waiting. `None` budget waits without bound.
pub(crate) async fn await_deadline<T: Clone>(
    clock: &dyn Clock,
    pending: &Settled<T>,
    started: Duration,
    budget_ms: Option<u64>,
    on_timeout: impl FnOnce() -> T,
) -> T {
    let Some(budget_ms) = budget_ms else {
        return pending.wait().await;
    };
    let budget = Duration::from_millis(budget_ms);
    loop {
        if let Some(value) = pending.peek() {
            if since(clock, started) < budget {
                return value;
            }
            break;
        }
        let remaining = budget.saturating_sub(since(clock, started));
        let timer = clock.sleep(remaining);
        match select(pending.wait(), timer).await {
            Either::Left((value, _timer)) => {
                if since(clock, started) < budget {
                    return value;
                }
                break;
            }
            Either::Right(((), _wait)) => {
                // Timer precision and delivery do not define the semantic boundary.
                if since(clock, started) < budget {
                    continue;
                }
                break;
            }
        }
    }
    on_timeout()
}
