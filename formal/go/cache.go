// Package dialcache is a bounded reference for the portable core profile. It is
// an independently executed cache, not an interpreter of expected model state.
package dialcache

import (
	"context"
	"errors"
	"sync"
	"time"
)

type Clock interface {
	WallMS() int64
	ElapsedMS() int64
}
type systemClock struct{ origin time.Time }

func (c systemClock) WallMS() int64    { return time.Now().UnixMilli() }
func (c systemClock) ElapsedMS() int64 { return time.Since(c.origin).Milliseconds() }

// Remote is the semantic adapter boundary; Read must atomically observe a
// primary value and its watermark when the watermark key is nonempty.
type Remote interface {
	Read(context.Context, string, string) (ReadResult, error)
	Write(context.Context, string, Frame, int64) error
	Invalidate(context.Context, string, int64, int64) error
}

// Payload preserves the serializer's text/binary distinction through the
// remote frame. Text bytes undergo the protocol's replacement UTF-8 decoding;
// binary bytes remain exact. Codecs receive the same distinction when reading.
type Payload struct {
	Bytes  []byte
	Binary bool
}
type Codec[T any] interface {
	Encode(T) (Payload, error)
	Decode(Payload) (T, error)
}
type Policy struct {
	RequestLocal      bool
	LocalTTLMS        int64
	RemoteTTLMS       int64
	DisableCoalescing bool
}
type Operation struct {
	Identity Identity
	Policy   Policy
}
type Event struct {
	Kind  string
	Scope string
	Key   string
}
type Options[T any] struct {
	Remote        Remote
	Codec         Codec[T]
	Clock         Clock
	LocalCapacity int
	Observe       func(Event)
}
type entry[T any] struct {
	value   T
	expires int64
	used    uint64
}
type flight[T any] struct {
	done  chan struct{}
	value T
	err   error
}
type scope[T any] struct {
	live    bool
	memo    map[string]T
	flights map[string]*flight[T]
}
type scopeState[T any] struct {
	enabled bool
	owner   *scope[T]
}

type Cache[T any] struct {
	mu       sync.Mutex
	options  Options[T]
	local    map[string]entry[T]
	flights  map[string]*flight[T]
	sequence uint64
}

func New[T any](options Options[T]) *Cache[T] {
	if options.Clock == nil {
		options.Clock = systemClock{origin: time.Now()}
	}
	return &Cache[T]{options: options, local: make(map[string]entry[T]), flights: make(map[string]*flight[T])}
}

// Enable reuses a live outer lifetime, including when nested inside Disable.
// Completing an outer callback closes only that scope, preventing late memo
// publication. Context cancellation remains an application/source concern.
func (c *Cache[T]) Enable(ctx context.Context, fn func(context.Context) error) error {
	prior, _ := ctx.Value(c).(scopeState[T])
	c.mu.Lock()
	owned := prior.owner == nil || !prior.owner.live
	s := prior.owner
	if owned {
		s = &scope[T]{live: true, memo: make(map[string]T), flights: make(map[string]*flight[T])}
	}
	c.mu.Unlock()
	if owned {
		defer func() { c.mu.Lock(); s.live = false; clear(s.memo); clear(s.flights); c.mu.Unlock() }()
	}
	return fn(context.WithValue(ctx, c, scopeState[T]{enabled: true, owner: s}))
}

func (c *Cache[T]) Disable(ctx context.Context, fn func(context.Context) error) error {
	state, _ := ctx.Value(c).(scopeState[T])
	state.enabled = false
	return fn(context.WithValue(ctx, c, state))
}
func (c *Cache[T]) IsEnabled(ctx context.Context) bool {
	state, _ := ctx.Value(c).(scopeState[T])
	c.mu.Lock()
	defer c.mu.Unlock()
	return state.enabled && state.owner != nil && state.owner.live
}

func (c *Cache[T]) emit(event Event) {
	if c.options.Observe != nil {
		func() { defer func() { _ = recover() }(); c.options.Observe(event) }()
	}
}

func (c *Cache[T]) GetOrLoad(ctx context.Context, op Operation, load func(context.Context) (T, error)) (T, error) {
	if !c.IsEnabled(ctx) {
		return load(ctx)
	}
	key, remoteKey, watermark, err := op.Identity.Keys()
	if err != nil {
		return load(ctx)
	}
	state, _ := ctx.Value(c).(scopeState[T])
	runShared := func() (T, error) { return c.shared(ctx, op, key, remoteKey, watermark, load) }
	if !op.Policy.RequestLocal {
		return runShared()
	}
	runRequest := func() (T, error) {
		c.mu.Lock()
		value, found := state.owner.memo[key]
		live := state.owner.live
		c.mu.Unlock()
		if live && found {
			return value, nil
		}
		value, err := runShared()
		if err == nil {
			c.mu.Lock()
			if state.owner.live {
				state.owner.memo[key] = value
			}
			c.mu.Unlock()
		}
		return value, err
	}
	if op.Policy.DisableCoalescing {
		return runRequest()
	}
	return c.singleFlight(state.owner.flights, state.owner, key, "request_local", runRequest)
}

func (c *Cache[T]) singleFlight(flights map[string]*flight[T], owner *scope[T], key, label string, run func() (T, error)) (T, error) {
	c.mu.Lock()
	if owner != nil && !owner.live {
		c.mu.Unlock()
		return run()
	}
	if existing := flights[key]; existing != nil {
		c.mu.Unlock()
		c.emit(Event{Kind: "coalesced", Scope: label, Key: key})
		<-existing.done
		return existing.value, existing.err
	}
	f := &flight[T]{done: make(chan struct{})}
	flights[key] = f
	c.mu.Unlock()
	f.value, f.err = run()
	c.mu.Lock()
	if flights[key] == f {
		delete(flights, key)
	}
	close(f.done)
	c.mu.Unlock()
	return f.value, f.err
}

func (c *Cache[T]) shared(ctx context.Context, op Operation, key, remoteKey, watermark string, load func(context.Context) (T, error)) (T, error) {
	localActive := op.Policy.LocalTTLMS > 0
	remoteActive := op.Policy.RemoteTTLMS > 0 && c.options.Remote != nil && c.options.Codec != nil
	run := func() (T, error) {
		if localActive {
			if value, ok := c.localGet(key); ok {
				return value, nil
			}
		}
		var fence *uint64
		refill := false
		if remoteActive {
			result, err := c.options.Remote.Read(ctx, remoteKey, watermark)
			if err == nil && result.Error() == nil {
				refill = true
				if result.Kind == "miss" {
					fence = result.ObservedWatermarkMS
				}
				if result.Kind == "hit" {
					stamp := result.Frame.CreatedAtMS
					age := c.options.Clock.WallMS() - int64(stamp)
					if stamp <= MaxSafeInteger && age >= 0 && age < op.Policy.RemoteTTLMS {
						if value, decodeErr := c.options.Codec.Decode(Payload{Bytes: result.Frame.Payload, Binary: result.Frame.Binary}); decodeErr == nil {
							if localActive {
								c.localPut(key, value, op.Policy.LocalTTLMS)
							}
							return value, nil
						}
					}
				}
			}
		}
		value, err := load(ctx)
		if err != nil {
			return value, err
		}
		if refill {
			stamp := c.options.Clock.WallMS()
			if fence == nil || stamp >= 0 && uint64(stamp) > *fence {
				if payload, encodeErr := c.options.Codec.Encode(value); encodeErr == nil {
					stamp = c.options.Clock.WallMS()
					if stamp >= 0 && uint64(stamp) <= MaxSafeInteger && (fence == nil || uint64(stamp) > *fence) {
						ttl := op.Policy.RemoteTTLMS
						if op.Identity.Tracked && ttl > 3600000 {
							ttl = 3600000
						}
						_ = c.options.Remote.Write(ctx, remoteKey, Frame{CreatedAtMS: uint64(stamp), Binary: payload.Binary, Payload: payload.Bytes}, ttl)
					}
				}
			}
		}
		if localActive && !(remoteActive && op.Identity.Tracked) {
			c.localPut(key, value, op.Policy.LocalTTLMS)
		}
		return value, nil
	}
	if op.Policy.DisableCoalescing || !localActive && !remoteActive {
		return run()
	}
	return c.singleFlight(c.flights, nil, key, "process", run)
}

func (c *Cache[T]) localGet(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, found := c.local[key]
	if found && c.options.Clock.ElapsedMS() >= item.expires {
		delete(c.local, key)
		found = false
	}
	if found {
		c.sequence++
		item.used = c.sequence
		c.local[key] = item
	}
	return item.value, found
}
func (c *Cache[T]) localPut(key string, value T, ttl int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.options.LocalCapacity <= 0 {
		return
	}
	c.sequence++
	c.local[key] = entry[T]{value: value, expires: c.options.Clock.ElapsedMS() + ttl, used: c.sequence}
	if len(c.local) > c.options.LocalCapacity {
		var oldest string
		stamp := ^uint64(0)
		for candidate, item := range c.local {
			if item.used < stamp {
				oldest = candidate
				stamp = item.used
			}
		}
		delete(c.local, oldest)
	}
}

func (c *Cache[T]) Invalidate(ctx context.Context, identity Identity, futureBufferMS int64) error {
	if futureBufferMS < 0 || futureBufferMS > 31536000000 {
		return errors.New("invalid future buffer")
	}
	if c.options.Remote == nil {
		return errors.New("missing remote")
	}
	identity.Tracked = true
	_, _, watermark, err := identity.Keys()
	if err != nil {
		return err
	}
	now := c.options.Clock.WallMS()
	if now < 0 || uint64(now) > MaxSafeInteger-uint64(futureBufferMS) {
		return errors.New("invalid invalidation timestamp")
	}
	return c.options.Remote.Invalidate(ctx, watermark, now, futureBufferMS)
}
