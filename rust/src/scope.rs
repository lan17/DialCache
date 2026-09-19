//! Enabled scopes and request memoization.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::flight::Flight;
use crate::local::StoredValue;

pub(crate) struct OwnerState {
    pub(crate) live: bool,
    pub(crate) memo: HashMap<String, StoredValue>,
    pub(crate) flights: HashMap<String, Arc<Flight>>,
}

/// The outermost enabled scope's request state: memo and registered request flights.
pub(crate) struct Owner {
    pub(crate) state: Mutex<OwnerState>,
}

impl fmt::Debug for Owner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Owner")
            .field("live", &self.is_live())
            .finish()
    }
}

impl Owner {
    pub(crate) fn new() -> Arc<Owner> {
        Arc::new(Owner {
            state: Mutex::new(OwnerState {
                live: true,
                memo: HashMap::new(),
                flights: HashMap::new(),
            }),
        })
    }

    pub(crate) fn is_live(&self) -> bool {
        self.state.lock().live
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock();
        state.live = false;
        state.memo.clear();
        state.flights.clear();
    }
}

/// A caching scope handle.
///
/// Caching is disabled by default. [`DialCache::enable`](crate::DialCache::enable)
/// opens the outermost enabled scope and hands its `Scope` to the callback;
/// pass it to every cached call made on behalf of that request. Nested
/// [`DialCache::enable_in`](crate::DialCache::enable_in) and
/// [`DialCache::disable_in`](crate::DialCache::disable_in) derive child
/// scopes that share the outer request memo. When the outermost callback
/// completes its scope closes: retained clones no longer enable caching and
/// late work cannot publish into the request memo.
///
/// [`Scope::outside`] is the pass-through scope of code that runs on behalf of
/// no request: calls made with it invoke their source directly.
#[derive(Clone)]
pub struct Scope {
    pub(crate) cache_id: u64,
    pub(crate) owner: Option<Arc<Owner>>,
    pub(crate) enabled: bool,
}

impl fmt::Debug for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Scope")
            .field("cache_id", &self.cache_id)
            .field("enabled", &self.is_enabled())
            .field("has_owner", &self.owner.is_some())
            .finish()
    }
}

impl Scope {
    /// The scope of work that runs on behalf of no request. Calls pass
    /// straight through to their source.
    pub fn outside() -> Scope {
        Scope {
            cache_id: 0,
            owner: None,
            enabled: false,
        }
    }

    /// Whether caching is enabled for calls made with this scope: it was
    /// derived from an enabled scope and its outermost scope is still open.
    pub fn is_enabled(&self) -> bool {
        self.enabled && self.owner.as_ref().is_some_and(|owner| owner.is_live())
    }

    pub(crate) fn live_owner(&self) -> Option<Arc<Owner>> {
        self.owner.as_ref().filter(|owner| owner.is_live()).cloned()
    }

    pub(crate) fn disabled_view(&self) -> Scope {
        Scope {
            cache_id: self.cache_id,
            owner: self.owner.clone(),
            enabled: false,
        }
    }
}
