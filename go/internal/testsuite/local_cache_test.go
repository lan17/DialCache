package dialcache_test

import (
	"context"
	. "github.com/lan17/DialCache/go"
	"github.com/lan17/DialCache/go/internal/localcache"
	"strconv"
	"sync"
	"testing"
	"time"
)

// stepClock is a deterministic integer clock advanced only between public
// calls on the test goroutine. Deadlines and diagnostics use ElapsedTime;
// only local storage reads ElapsedMS, so a fault there hits just that seam.
type stepClock struct {
	wall, elapsed int64
	fault         bool // panic on local storage clock reads
}

func (c *stepClock) WallMS() int64              { return c.wall }
func (c *stepClock) ElapsedTime() time.Duration { return time.Duration(c.elapsed) * time.Millisecond }
func (c *stepClock) ElapsedMS() int64 {
	if c.fault {
		panic("controlled local storage failure")
	}
	return c.elapsed
}
func (c *stepClock) advance(ms int64) { c.wall += ms; c.elapsed += ms }

// localOnlyLoader returns a loader over one local-only cache. Each source call
// returns its ordinal, so a hit repeats the earlier ordinal and a miss returns
// a fresh one; the expected values below come only from these public results.
func localOnlyLoader(t *testing.T, cache *Cache) func(id string, ttlMS int64) int {
	t.Helper()
	sources := 0
	return func(id string, ttlMS int64) int {
		op := Operation[int]{Identity: Identity{KeyType: "lru", ID: id, UseCase: "local"}, Policy: Policy{LocalTTL: time.Duration(ttlMS) * time.Millisecond}}
		var value int
		if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			var err error
			value, err = GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { sources++; return sources, nil })
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func TestLocalEvictionIsLeastRecentlyUsedWithReadPromotion(t *testing.T) {
	clock := &stepClock{}
	load := localOnlyLoader(t, MustNew(WithClock(clock), WithLocalCapacity(2)))
	const ttl = int64(60000)
	if load("a", ttl) != 1 || load("b", ttl) != 2 {
		t.Fatal("initial fills did not reach the source in order")
	}
	// Reading a promotes it, so b becomes the least recently used entry.
	if load("a", ttl) != 1 {
		t.Fatal("a was not served from local storage")
	}
	if load("c", ttl) != 3 {
		t.Fatal("c did not miss")
	}
	// Capacity two now holds a and c; b was evicted, not the promoted a.
	if load("a", ttl) != 1 {
		t.Fatal("promoted entry a was evicted instead of b")
	}
	if load("b", ttl) != 4 {
		t.Fatal("least recently used entry b survived eviction")
	}
	// Reinserting b evicted c, the least recently used of {a, c}. Refilling c
	// then evicts a, the least recently used of {a, b}, while b stays warm.
	if load("c", ttl) != 5 || load("b", ttl) != 4 || load("a", ttl) != 6 {
		t.Fatal("eviction did not follow least recent use after reinsertion")
	}
}

func TestLocalEvictionIgnoresExpiryOfNewerEntries(t *testing.T) {
	// lru-cache without ttlAutopurge evicts by recency alone; an unread expired
	// entry keeps its position. Both ports must choose the same victim so a
	// shared history observes the same later hits and misses.
	clock := &stepClock{}
	load := localOnlyLoader(t, MustNew(WithClock(clock), WithLocalCapacity(2)))
	if load("a", 60000) != 1 || load("b", 1000) != 2 {
		t.Fatal("initial fills did not reach the source in order")
	}
	clock.advance(1000) // b is expired but unread; a is live and least recent.
	if load("c", 60000) != 3 {
		t.Fatal("c did not miss")
	}
	// Under a prefer-expired victim policy a would still be present and hit.
	if load("a", 60000) != 4 {
		t.Fatal("live least recently used entry a should have been evicted ahead of expired b")
	}
}

func TestLocalReadFailureDoesNotPromoteTheEntry(t *testing.T) {
	// A failed local read is isolated and served from the source. It must not
	// reorder the LRU: in TypeScript the fault precedes any lru-cache access.
	clock := &stepClock{}
	load := localOnlyLoader(t, MustNew(WithClock(clock), WithLocalCapacity(2)))
	const ttl = int64(60000)
	if load("a", ttl) != 1 || load("b", ttl) != 2 {
		t.Fatal("initial fills did not reach the source in order")
	}
	clock.fault = true
	if load("a", ttl) != 3 {
		t.Fatal("failed local read did not fall through to the source")
	}
	clock.fault = false
	// a is still the least recently used entry, so filling c evicts a, not b.
	if load("c", ttl) != 4 || load("b", ttl) != 2 || load("a", ttl) != 5 {
		t.Fatal("a failed read changed the eviction order")
	}
}

func TestLocalExpiryIsCheckedOnReadWithoutRenewal(t *testing.T) {
	clock := &stepClock{}
	load := localOnlyLoader(t, MustNew(WithClock(clock), WithLocalCapacity(2)))
	if load("a", 1000) != 1 {
		t.Fatal("initial fill did not reach the source")
	}
	clock.advance(999)
	if load("a", 1000) != 1 {
		t.Fatal("entry expired before its TTL boundary")
	}
	clock.advance(1) // Reads never renew insertion; the boundary is 1000 ms after the fill.
	if load("a", 1000) != 2 {
		t.Fatal("entry survived its TTL boundary")
	}
	clock.advance(999)
	if load("a", 1000) != 2 {
		t.Fatal("refilled entry did not receive a full TTL")
	}
}

func TestLocalStorageConcurrentChurnIsRaceFree(t *testing.T) {
	// Exercised under -race: simplelru is not goroutine-safe, so every access
	// must stay under the cache mutex. The capacity bound itself is structural.
	const capacity, keys, workers = 100, 2000, 8
	cache := MustNew(WithLocalCapacity(capacity))
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < keys; i++ {
				op := Operation[int]{Identity: Identity{KeyType: "churn", ID: strconv.Itoa((worker*7 + i) % keys), UseCase: "local"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond, Coalesce: Ptr(false)}}
				if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					_, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { return i, nil })
					return err
				}); err != nil {
					t.Error(err)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
}

// benchmarkKeys formats fresh keys ahead of the timed loop so key formatting
// is not attributed to the storage operation.
func benchmarkKeys(first, count int) []string {
	keys := make([]string, count)
	for i := range keys {
		keys[i] = strconv.Itoa(first + i)
	}
	return keys
}

// BenchmarkLocalPutEviction isolates one insertion at capacity, which must
// evict the least recently used entry, on the process-local storage.
func BenchmarkLocalPutEviction(b *testing.B) {
	const capacity = 10000
	origin := time.Now()
	cache, err := localcache.New(capacity, func() int64 { return time.Since(origin).Milliseconds() })
	if err != nil {
		b.Fatal(err)
	}
	for i := 0; i < capacity; i++ {
		cache.Put(strconv.Itoa(i), i, 60000)
	}
	keys := benchmarkKeys(capacity, b.N)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		cache.Put(keys[i], i, 60000)
	}
}

// BenchmarkLocalMissAtCapacity measures a public local-only miss whose fill
// evicts, including key construction, policy resolution and diagnostics.
func BenchmarkLocalMissAtCapacity(b *testing.B) {
	const capacity = 10000
	cache := MustNew(WithLocalCapacity(capacity))
	operation := func(id string) Operation[int] {
		return Operation[int]{Identity: Identity{KeyType: "bench", ID: id, UseCase: "local"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond}}
	}
	source := func(context.Context) (int, error) { return 1, nil }
	if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
		for i := 0; i < capacity; i++ {
			if _, err := GetOrLoad(ctx, cache, operation(strconv.Itoa(i)), source); err != nil {
				return err
			}
		}
		keys := benchmarkKeys(capacity, b.N)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := GetOrLoad(ctx, cache, operation(keys[i]), source); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		b.Fatal(err)
	}
}
