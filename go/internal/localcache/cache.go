// Package localcache implements the process-local value store.
package localcache

import (
	"sync"

	"github.com/hashicorp/golang-lru/v2/simplelru"
)

// entry retains its insertion-time TTL. Expiry is checked lazily on read:
// an unread expired entry keeps its LRU position until read or evicted.
type entry struct {
	value      any
	insertedMS int64
	ttlMS      int64
}

// Store holds process-local values. A nil Store disables local storage.
type Store struct {
	mu        sync.Mutex
	entries   *simplelru.LRU[string, entry]
	elapsedMS func() int64
}

func New(capacity int, elapsedMS func() int64) (*Store, error) {
	// The LRU allocates per entry, so a large configured capacity stays sparse.
	entries, err := simplelru.NewLRU[string, entry](capacity, nil)
	if err != nil {
		return nil, err
	}
	return &Store{entries: entries, elapsedMS: elapsedMS}, nil
}

func (s *Store) Get(key string) (any, bool) {
	if s == nil {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Check freshness before promotion. A failed clock read must leave the
	// LRU order untouched, matching the TypeScript local-cache fault seam.
	item, found := s.entries.Peek(key)
	if !found {
		return nil, false
	}
	if s.elapsedMS()-item.insertedMS >= item.ttlMS {
		s.entries.Remove(key)
		return nil, false
	}
	s.entries.Get(key)
	return item.value, true
}

func (s *Store) Put(key string, value any, ttlMS int64) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Add promotes existing keys and evicts the least recently used entry at
	// capacity, regardless of that entry's remaining TTL.
	s.entries.Add(key, entry{value: value, insertedMS: s.elapsedMS(), ttlMS: ttlMS})
}
