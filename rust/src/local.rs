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
    /// Read one key. A live entry is promoted and returned; an expired entry
    /// is removed without promotion and handed back so the cache can drop it
    /// outside its lock.
    fn get(&mut self, key: &str, now_ms: i64) -> Result<LocalRead, BoxError>;
    /// Insert or replace an entry, promoting it and evicting at capacity.
    /// Returns the displaced entry (the replaced value or the evicted tail),
    /// which the cache drops outside its lock.
    fn put(&mut self, key: String, entry: LocalEntry) -> Result<Option<LocalEntry>, BoxError>;
}

/// The outcome of one [`LocalStore::get`].
///
/// Removed entries travel back to the cache instead of dropping inside the
/// store, because a value's destructor may call back into the cache and the
/// store runs under the cache's lock.
#[derive(Debug)]
pub enum LocalRead {
    /// No entry under the key.
    Absent,
    /// The entry had expired and was removed.
    Expired(LocalEntry),
    /// A live entry, promoted.
    Live(StoredValue),
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
    fn get(&mut self, key: &str, now_ms: i64) -> Result<LocalRead, BoxError> {
        // Peek, check freshness, then promote: an expired entry leaves the LRU
        // order untouched apart from its own removal.
        let expired = match self.entries.peek(key) {
            None => return Ok(LocalRead::Absent),
            Some(entry) => now_ms.saturating_sub(entry.inserted_ms) >= entry.ttl_ms,
        };
        if expired {
            return Ok(match self.entries.pop(key) {
                Some(entry) => LocalRead::Expired(entry),
                None => LocalRead::Absent,
            });
        }
        Ok(match self.entries.get(key) {
            Some(entry) => LocalRead::Live(entry.value.clone()),
            None => LocalRead::Absent,
        })
    }

    fn put(&mut self, key: String, entry: LocalEntry) -> Result<Option<LocalEntry>, BoxError> {
        Ok(self
            .entries
            .push(key, entry)
            .map(|(_, displaced)| displaced))
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
