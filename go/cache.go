// Package dialcache provides explicitly enabled, layered caching with runtime
// rollout, request coalescing, invalidation, stale recovery and shadow validation.
package dialcache

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/hashicorp/golang-lru/v2/simplelru"
)

// entry is one process-local value with its insertion-time TTL. Expiry is
// checked lazily on read against Clock.ElapsedMS, as lru-cache does in
// TypeScript without ttlAutopurge: an unread expired entry keeps its LRU
// position until a read removes it or capacity evicts it.
type entry struct {
	value      any
	insertedMS int64
	ttlMS      int64
}
type flight struct {
	done      chan struct{}
	value     any
	err       error
	started   time.Duration
	followers int
}
type scope struct {
	live    bool
	memo    map[string]any
	flights map[string]*flight
}
type scopeState struct {
	enabled bool
	owner   *scope
}

// Cache is one DialCache instance: a process-local LRU, coalescing table,
// shadow slots and use case registry shared by every value type.
type Cache struct {
	mu       sync.Mutex
	settings settings
	// local is nil when zero capacity disables local storage. Reads and writes
	// both promote; the least recently used entry is evicted at capacity.
	local      *simplelru.LRU[string, entry]
	flights    map[string]*flight
	shadows    map[string]*shadowFlight
	registered map[string]bool
}

// New constructs a cache. Options are applied in order; an invalid option
// returns an error wrapping ErrInvalidOption.
func New(opts ...Option) (*Cache, error) {
	compression, err := ResolveCompressionConfig(nil)
	if err != nil {
		return nil, err
	}
	s := settings{
		clock:             newSystemClock(),
		namespace:         "urn",
		localCapacity:     10000,
		remoteReadTimeout: DefaultRemoteReadTimeout,
		shadowCapacity:    1,
		logger:            defaultLogger{},
		compression:       &compression,
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(&s); err != nil {
			return nil, err
		}
	}
	s.logger = FailureIsolatedLogger(s.logger)
	c := &Cache{settings: s, flights: make(map[string]*flight), shadows: make(map[string]*shadowFlight), registered: make(map[string]bool)}
	if s.localCapacity > 0 {
		// The LRU allocates per entry, so a large configured capacity stays sparse.
		local, err := simplelru.NewLRU[string, entry](s.localCapacity, nil)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidOption, err)
		}
		c.local = local
	}
	return c, nil
}

// MustNew is New for configuration known to be valid; it panics otherwise.
func MustNew(opts ...Option) *Cache {
	c, err := New(opts...)
	if err != nil {
		panic(err)
	}
	return c
}

// Enable returns a context in which cached operations participate, and the
// function that closes that request scope. Call it when the request's work
// is complete, typically with defer: it ends the request memo lifetime and
// prevents late publication into it. A context enabled inside a live scope
// shares that scope, and its close function does nothing. Retaining the
// context after close does not keep caching enabled. Context cancellation
// remains an application and source concern.
func (c *Cache) Enable(ctx context.Context) (context.Context, func()) {
	prior, _ := ctx.Value(c).(scopeState)
	c.mu.Lock()
	owned := prior.owner == nil || !prior.owner.live
	s := prior.owner
	if owned {
		s = &scope{live: true, memo: make(map[string]any), flights: make(map[string]*flight)}
	}
	c.mu.Unlock()
	var once sync.Once
	done := func() {
		if !owned {
			return
		}
		once.Do(func() {
			c.mu.Lock()
			s.live = false
			clear(s.memo)
			clear(s.flights)
			c.mu.Unlock()
		})
	}
	return context.WithValue(ctx, c, scopeState{enabled: true, owner: s}), done
}

// WithEnabled runs fn inside an enabled scope that closes when fn returns.
func (c *Cache) WithEnabled(ctx context.Context, fn func(context.Context) error) error {
	ctx, done := c.Enable(ctx)
	defer done()
	return fn(ctx)
}

// Disable returns a context whose cached operations pass straight through to
// their sources. Enabling again inside it rejoins the surrounding live scope.
func (c *Cache) Disable(ctx context.Context) context.Context {
	state, _ := ctx.Value(c).(scopeState)
	state.enabled = false
	return context.WithValue(ctx, c, state)
}

// WithDisabled runs fn with caching disabled.
func (c *Cache) WithDisabled(ctx context.Context, fn func(context.Context) error) error {
	return fn(c.Disable(ctx))
}

// IsEnabled reports whether operations with ctx participate in caching.
func (c *Cache) IsEnabled(ctx context.Context) bool {
	state, _ := ctx.Value(c).(scopeState)
	c.mu.Lock()
	defer c.mu.Unlock()
	return state.enabled && state.owner != nil && state.owner.live
}

func (c *Cache) emit(event Event) {
	if c.settings.observe != nil {
		func() { defer func() { _ = recover() }(); c.settings.observe(event) }()
	}
}

func (c *Cache) localGet(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.local == nil {
		return nil, false
	}
	// Peek, then check freshness, then promote: lru-cache checks staleness
	// before any promotion, and a clock read that fails must leave the LRU
	// order untouched, exactly as the TypeScript fault seam does.
	item, found := c.local.Peek(key)
	if !found {
		return nil, false
	}
	// Match the TypeScript local cache's whole-millisecond monotonic clock.
	// Source/read/shadow deadlines separately retain fractional elapsed time.
	if c.settings.clock.ElapsedMS()-item.insertedMS >= item.ttlMS {
		c.local.Remove(key)
		return nil, false
	}
	c.local.Get(key)
	return item.value, true
}
func (c *Cache) localPut(key string, value any, ttl int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.local == nil {
		return
	}
	// Add promotes an existing key and evicts the least recently used entry
	// once capacity is exceeded, regardless of that entry's remaining TTL.
	c.local.Add(key, entry{value: value, insertedMS: c.settings.clock.ElapsedMS(), ttlMS: ttl})
}

// Invalidate raises the remote watermark for every tracked value of the
// entity named by identity's KeyType and ID, so frames stamped at or before
// the invalidation plus futureBuffer are no longer served. It requires a
// remote adapter and returns its error. Local entries expire by TTL.
func (c *Cache) Invalidate(ctx context.Context, identity Identity, futureBuffer time.Duration) (err error) {
	if futureBuffer < 0 || futureBuffer > MaxSupportedDuration || futureBuffer%time.Millisecond != 0 {
		return fmt.Errorf("%w: future buffer must be whole milliseconds within 365 days", ErrInvalidOperation)
	}
	if identity.Namespace == "" {
		identity.Namespace = c.settings.namespace
	}
	c.emit(Event{Kind: "invalidation", Data: map[string]any{"cacheNamespace": identity.Namespace, "keyType": identity.KeyType, "layer": "remote"}})
	defer func() {
		if err != nil {
			c.settings.logger.Warn("Error writing DialCache invalidation watermark", err)
			c.emit(Event{Kind: "error", Data: map[string]any{"cacheNamespace": identity.Namespace, "keyType": identity.KeyType, "useCase": "watermark", "layer": "remote", "error": "invalidation", "inFallback": false}})
		}
	}()
	if c.settings.remote == nil {
		return ErrNoRemote
	}
	identity.Tracked = true
	_, _, watermark, err := identity.Keys()
	if err != nil {
		return err
	}
	now := c.settings.clock.WallMS()
	bufferMS := int64(futureBuffer / time.Millisecond)
	if now < 0 || uint64(now) > MaxSafeInteger-uint64(bufferMS) {
		return fmt.Errorf("%w: invalid invalidation timestamp", ErrInvalidOperation)
	}
	_, err = callSafely(func() (struct{}, error) {
		return struct{}{}, c.settings.remote.Invalidate(ctx, watermark, now, bufferMS)
	})
	return err
}
