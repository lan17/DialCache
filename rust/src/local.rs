//! Process-local storage.

use std::any::Any;
use std::num::NonZeroUsize;
use std::sync::Arc;

use crate::error::BoxError;

/// A type-erased cached value shared by reference.
pub type StoredValue = Arc<dyn Any + Send + Sync>;

/// One process-local entry with its insertion-time TTL.
#[derive(Clone)]
pub struct LocalEntry {
    pub value: StoredValue,
    /// Whole-millisecond elapsed reading at insertion.
    pub inserted_ms: i64,
    pub ttl_ms: i64,
}

/// Process-local storage for one cache instance.
///
/// The default [`LruLocalStore`] evicts the least recently used entry at
/// capacity regardless of its remaining TTL, checks expiry lazily on read
/// against whole elapsed milliseconds, promotes on read and write, and never
/// renews a TTL on read. Implementations must preserve those rules.
pub trait LocalStore: Send + 'static {
    /// Return a live entry's value, promoting it. Expired entries are removed
    /// and reported as absent without promotion.
    fn get(&mut self, key: &str, now_ms: i64) -> Result<Option<StoredValue>, BoxError>;
    /// Insert or replace an entry, promoting it and evicting at capacity.
    fn put(&mut self, key: String, entry: LocalEntry) -> Result<(), BoxError>;
}

/// The default LRU store.
pub struct LruLocalStore {
    entries: lru::LruCache<String, LocalEntry>,
}

impl LruLocalStore {
    /// A store holding at most `capacity` entries. Capacity must be positive.
    pub fn new(capacity: NonZeroUsize) -> Self {
        LruLocalStore {
            entries: lru::LruCache::new(capacity),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl LocalStore for LruLocalStore {
    fn get(&mut self, key: &str, now_ms: i64) -> Result<Option<StoredValue>, BoxError> {
        // Peek, check freshness, then promote: an expired entry leaves the LRU
        // order untouched apart from its own removal.
        let expired = match self.entries.peek(key) {
            None => return Ok(None),
            Some(entry) => now_ms.saturating_sub(entry.inserted_ms) >= entry.ttl_ms,
        };
        if expired {
            self.entries.pop(key);
            return Ok(None);
        }
        Ok(self.entries.get(key).map(|entry| entry.value.clone()))
    }

    fn put(&mut self, key: String, entry: LocalEntry) -> Result<(), BoxError> {
        self.entries.put(key, entry);
        Ok(())
    }
}

impl std::fmt::Debug for LocalEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalEntry")
            .field("inserted_ms", &self.inserted_ms)
            .field("ttl_ms", &self.ttl_ms)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for LruLocalStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LruLocalStore")
            .field("len", &self.entries.len())
            .field("cap", &self.entries.cap())
            .finish()
    }
}
