package dialcache

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"
)

type execution[T any] struct {
	cache                     *Cache
	ctx                       context.Context
	op                        Operation[T]
	key, remoteKey, watermark string
	policy                    ResolvedPolicy
	load                      func(context.Context) (T, error)
	timedOut                  atomic.Bool
}

// ms converts a whole-millisecond duration to the wire and clock unit.
func ms(d time.Duration) int64 { return int64(d / time.Millisecond) }

func (x *execution[T]) labels(layer string) map[string]any {
	d := map[string]any{"cacheNamespace": x.op.Identity.Namespace, "useCase": x.op.Identity.UseCase, "keyType": x.op.Identity.KeyType}
	if layer != "" {
		d["layer"] = layer
	}
	return d
}
func (x *execution[T]) event(kind, layer string, extra map[string]any) {
	d := x.labels(layer)
	for k, v := range extra {
		d[k] = v
	}
	e := Event{Kind: kind, Key: x.key, Data: d}
	if scope, ok := d["scope"].(string); ok {
		e.Scope = scope
	}
	if n, ok := d["seconds"].(float64); ok {
		e.Seconds = n
	}
	if n, ok := d["bytes"].(int64); ok {
		e.Bytes = n
	}
	if outcome, ok := d["outcome"].(string); ok {
		e.Outcome = outcome
	}
	x.cache.emit(e)
}
func (x *execution[T]) errorEvent(layer, kind string, inFallback bool) {
	x.event("error", layer, map[string]any{"error": kind, "inFallback": inFallback})
}
func (x *execution[T]) elapsed(start time.Duration) float64 {
	n := elapsedNow(x.cache.settings.clock) - start
	if n < 0 {
		n = 0
	}
	return n.Seconds()
}
func (x *execution[T]) duration(kind, layer string, start time.Duration, extra map[string]any) {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["seconds"] = x.elapsed(start)
	x.event(kind, layer, extra)
}

// GetOrLoad executes one inline loader through the cache chain without
// registering its use case. Outside an enabled scope it calls load directly.
// Returned in-memory values are shared and must be treated as immutable.
func GetOrLoad[T any](ctx context.Context, c *Cache, op Operation[T], load func(context.Context) (T, error)) (T, error) {
	var zero T
	if c == nil || load == nil {
		return zero, fmt.Errorf("%w: GetOrLoad requires a cache and a source", ErrInvalidOperation)
	}
	if err := validateOperation(op); err != nil {
		return zero, err
	}
	op.Policy = SnapshotPolicy(op.Policy)
	if op.Identity.Namespace == "" {
		op.Identity.Namespace = c.settings.namespace
	}
	x := &execution[T]{cache: c, ctx: ctx, op: op, load: load}
	if !c.IsEnabled(ctx) {
		x.event("disabled", "noop", map[string]any{"reason": "context"})
		return callSafely(func() (T, error) { return load(ctx) })
	}
	if op.IdentityProvider != nil {
		identity, err := callSafely(op.IdentityProvider)
		// Computed identities are cache plumbing: invalid results fail open,
		// while invalid static operation metadata is rejected above.
		if err == nil && identity.UseCase == "watermark" {
			err = ErrReservedUseCase
		}
		if err != nil {
			c.settings.logger.Error("Could not construct DialCache key", err)
			x.errorEvent("noop", "key_construction", false)
			return x.source("noop")
		}
		if identity.Namespace == "" {
			identity.Namespace = c.settings.namespace
		}
		op.Identity = identity
	}
	// Freeze the logical identity before the asynchronous provider runs. Policy
	// cohorts and subsequent effects must refer to the key accepted at admission.
	op.Identity.Args = append([][2]string(nil), op.Identity.Args...)
	x.op = op
	key, remoteKey, watermark, err := op.Identity.Keys()
	if err != nil {
		c.settings.logger.Error("Could not construct DialCache key", err)
		x.errorEvent("noop", "key_construction", false)
		return x.source("noop")
	}
	x.key, x.remoteKey, x.watermark = key, remoteKey, watermark
	var overlay RuntimePolicy
	if c.settings.policyProvider != nil {
		overlay, err = callSafely(func() (RuntimePolicy, error) { return c.settings.policyProvider(ctx, op.Identity) })
	}
	if err == nil {
		x.policy, err = ResolvePolicy(op.Policy, overlay, op.Identity, PolicyDefaults{RemoteReadTimeout: c.settings.remoteReadTimeout})
	}
	if err != nil {
		c.settings.logger.Warn("Could not resolve DialCache key config", err)
		x.errorEvent("noop", "config_resolution", false)
		x.event("disabled", "noop", map[string]any{"reason": "config_error"})
		return x.source("noop")
	}
	if !c.IsEnabled(ctx) {
		x.event("disabled", "noop", map[string]any{"reason": "context"})
		return x.source("noop")
	}
	if !x.policy.RequestLocal {
		return x.shared("local")
	}
	state, _ := ctx.Value(c).(scopeState)
	run := func() (T, error) {
		start := elapsedNow(c.settings.clock)
		c.mu.Lock()
		raw, found := state.owner.memo[key]
		live := state.owner.live
		c.mu.Unlock()
		x.event("request", "request_local", nil)
		x.duration("get", "request_local", start, nil)
		if live && found {
			if v, ok := assertValue[T](raw); ok {
				return v, nil
			}
			// A memo shared with another value type is a programming error;
			// treat it as a miss with no decisive cause and refill it.
			x.event("miss", "request_local", map[string]any{"reason": "unclassified"})
		} else {
			x.event("miss", "request_local", map[string]any{"reason": "value_absent"})
		}
		v, err := x.shared("request_local")
		if err == nil {
			c.mu.Lock()
			if state.owner.live {
				state.owner.memo[key] = v
			}
			c.mu.Unlock()
		}
		return v, err
	}
	if !x.policy.Coalesce {
		return run()
	}
	return x.singleFlight(state.owner.flights, state.owner, "request_local", run)
}

func (x *execution[T]) singleFlight(flights map[string]*flight, owner *scope, label string, run func() (T, error)) (T, error) {
	c := x.cache
	// Read the clock before taking the lock. The caller-supplied clock is the
	// only external code on this path; a panic from it must not leave c.mu
	// held, or the scope cleanup in Enable would deadlock.
	started := elapsedNow(c.settings.clock)
	c.mu.Lock()
	if owner != nil && !owner.live {
		c.mu.Unlock()
		return run()
	}
	if f := flights[x.key]; f != nil {
		f.followers++
		c.mu.Unlock()
		x.event("coalesced", "", map[string]any{"scope": label})
		<-f.done
		return followerResult[T](f)
	}
	f := &flight{done: make(chan struct{}), started: started}
	flights[x.key] = f
	c.mu.Unlock()
	value, err := callSafely(run)
	f.value, f.err = value, err
	c.mu.Lock()
	if flights[x.key] == f {
		delete(flights, x.key)
	}
	close(f.done)
	c.mu.Unlock()
	return value, err
}

// followerResult hands a leader's settled result to a follower. A leader of
// another value type under the same key is a programming error.
func followerResult[T any](f *flight) (T, error) {
	var zero T
	if f.err != nil {
		return zero, f.err
	}
	if v, ok := assertValue[T](f.value); ok {
		return v, nil
	}
	return zero, ErrValueType
}

func (x *execution[T]) layer(layer string, r ResolvedLayer) {
	if !r.Enabled {
		x.event("disabled", layer, map[string]any{"reason": r.Reason})
		if r.Reason == "invalid_ttl" || r.Reason == "invalid_ramp" {
			x.errorEvent(layer, "config_resolution", false)
		}
	}
}
func (x *execution[T]) shared(fallbackLayer string) (T, error) {
	c := x.cache
	p := x.policy
	x.layer("local", p.Local)
	run := func() (T, error) {
		localMiss := false
		if p.Local.Enabled {
			start := elapsedNow(c.settings.clock)
			item, readErr := callSafely(func() (localResult[T], error) {
				raw, found := c.local.Get(x.key)
				if !found {
					return localResult[T]{}, nil
				}
				value, ok := assertValue[T](raw)
				return localResult[T]{value: value, found: ok, mismatch: !ok}, nil
			})
			if readErr != nil {
				c.settings.logger.Error("Error getting value from local cache", readErr)
				x.errorEvent("local", "cache_read", false)
				x.event("disabled", "local", map[string]any{"reason": "config_error"})
			} else {
				x.event("request", "local", nil)
				x.duration("get", "local", start, nil)
				if item.found {
					return item.value, nil
				}
				localMiss = true
				reason := "value_absent"
				if item.mismatch {
					reason = "unclassified"
				}
				x.event("miss", "local", map[string]any{"reason": reason})
			}
			fallbackLayer = "local"
		}
		if c.settings.remote == nil {
			v, e := x.source(fallbackLayer)
			if e == nil && localMiss {
				x.putLocal(v)
			}
			return v, e
		}
		if p.StaleOnErrorConfigError {
			x.errorEvent("remote", "config_resolution", false)
		}
		x.layer("remote", p.Remote)
		if !p.Remote.Enabled {
			if p.Remote.Reason == "ramped_down" {
				return x.darkSource(fallbackLayer, localMiss)
			}
			v, e := x.source(fallbackLayer)
			if e == nil && localMiss {
				x.putLocal(v)
			}
			return v, e
		}
		remote := x.readServing()
		if remote.kind == "hit" {
			if localMiss {
				x.putLocal(remote.value)
			}
			x.scheduleShadow(remote.frame, nil, 0)
			return remote.value, nil
		}
		v, err := x.source("remote")
		if err != nil {
			if remote.kind != "error" && remote.kind != "decode_error" && p.StaleOnErrorMaxAge > 0 && x.canRecover(err) {
				if value, ok := x.recover(remote.frame); ok {
					return value, nil
				}
			}
			return v, err
		}
		if remote.kind != "error" {
			if _, writeErr := x.putRemote(v, remote.fence, "remote", nil); writeErr != nil {
				c.settings.logger.Warn("Error putting value in Redis cache", writeErr)
			}
		}
		if localMiss && !x.op.Identity.Tracked {
			x.putLocal(v)
		}
		return v, nil
	}
	if p.Local.Enabled {
		if p.Coalesce {
			return x.singleFlight(c.flights, nil, "process", run)
		}
		return run()
	}
	// Remote admission is decided before joining, while traversal belongs to the leader.
	if p.Remote.Enabled && c.settings.remote != nil && p.Coalesce {
		return x.singleFlight(c.flights, nil, "process", run)
	}
	return run()
}

type localResult[T any] struct {
	value    T
	found    bool
	mismatch bool
}

func (x *execution[T]) putLocal(value T) {
	_, err := callSafely(func() (struct{}, error) {
		x.cache.local.Put(x.key, value, ms(x.policy.Local.TTL))
		return struct{}{}, nil
	})
	if err != nil {
		x.cache.settings.logger.Warn("Error putting value in local cache", err)
		x.errorEvent("local", "cache_write", false)
	}
}

// budget is the source deadline in whole milliseconds; negative disables it.
func (x *execution[T]) budget() int64 {
	switch {
	case x.op.SourceTimeout == NoTimeout:
		return -1
	case x.op.SourceTimeout == 0:
		return ms(DefaultSourceTimeout)
	default:
		return ms(x.op.SourceTimeout)
	}
}
func (x *execution[T]) source(layer string) (T, error) {
	clock := x.cache.settings.clock
	start := elapsedNow(clock)
	budget := x.budget()
	p := startPending(func() (T, error) { return x.load(x.ctx) })
	v, err := awaitDeadline(clock, p, start, budget, func() error {
		return &FallbackTimeoutError{UseCase: x.op.Identity.UseCase, Timeout: time.Duration(budget) * time.Millisecond}
	}, func() { x.timedOut.Store(true) })
	if err != nil {
		x.errorEvent(layer, "fallback", true)
	}
	x.duration("fallback", layer, start, nil)
	return v, err
}

type remoteValue[T any] struct {
	kind  string
	value T
	frame *Frame
	fence *uint64
}

func (x *execution[T]) rawRead() (*pending[ReadResult], *pending[ReadResult]) {
	timeout := x.policy.RemoteReadTimeout
	ctx, cancel := context.WithCancel(context.WithValue(context.WithoutCancel(x.ctx), readBudgetKey{}, timeout))
	clock := x.cache.settings.clock
	start := elapsedNow(clock)
	raw := startPending(func() (ReadResult, error) { return x.cache.settings.remote.Read(ctx, x.remoteKey, x.watermark) })
	bounded := startPending(func() (ReadResult, error) {
		r, e := awaitDeadline(clock, raw, start, ms(timeout), func() error { return &RemoteReadTimeoutError{Timeout: timeout} }, cancel)
		if e != nil {
			return r, e
		}
		r = NormalizeReadResult(r, x.op.Identity.Tracked)
		return r, r.Error()
	})
	return bounded, raw
}
func (x *execution[T]) frameAge(frame *Frame, layer string) (int64, bool) {
	if frame == nil || frame.CreatedAtMS > MaxSafeInteger {
		return 0, false
	}
	age := x.cache.settings.clock.WallMS() - int64(frame.CreatedAtMS)
	if age < 0 {
		x.event("futureOffset", layer, map[string]any{"seconds": float64(-age) / 1000})
		return age, false
	}
	return age, true
}
func (x *execution[T]) readServing() remoteValue[T] {
	start := elapsedNow(x.cache.settings.clock)
	x.event("request", "remote", nil)
	defer x.duration("get", "remote", start, nil)
	p, _ := x.rawRead()
	<-p.done
	r, err := p.result.value, p.result.err
	if err != nil {
		x.cache.settings.logger.Warn("Error getting value from Redis cache", err)
		kind := "cache_read"
		var timeout *RemoteReadTimeoutError
		if errors.As(err, &timeout) {
			kind = "cache_read_timeout"
		}
		x.errorEvent("remote", kind, false)
		return remoteValue[T]{kind: "error"}
	}
	if r.Kind == "miss" {
		x.event("miss", "remote", map[string]any{"reason": r.Reason})
		return remoteValue[T]{kind: "miss", fence: r.ObservedWatermarkMS}
	}
	age, valid := x.frameAge(&r.Frame, "remote")
	if !valid {
		x.event("miss", "remote", map[string]any{"reason": "unclassified"})
		return remoteValue[T]{kind: "miss"}
	}
	maxAge := ms(x.policy.Remote.TTL)
	if x.policy.StaleOnErrorMaxAge > 0 {
		maxAge = ms(x.policy.StaleOnErrorMaxAge)
	}
	if age >= maxAge {
		x.event("miss", "remote", map[string]any{"reason": "expired"})
		return remoteValue[T]{kind: "miss"}
	}
	if age >= ms(x.policy.Remote.TTL) {
		x.event("miss", "remote", map[string]any{"reason": "expired"})
		return remoteValue[T]{kind: "retained", frame: &r.Frame}
	}
	value, err := x.decode(r.Frame, "remote")
	if err != nil {
		x.event("miss", "remote", map[string]any{"reason": "unclassified"})
		return remoteValue[T]{kind: "decode_error"}
	}
	return remoteValue[T]{kind: "hit", value: value, frame: &r.Frame}
}

func (x *execution[T]) decode(frame Frame, layer string) (T, error) {
	payload := Payload{Bytes: frame.Payload, Binary: frame.Binary}
	decompressStarted := elapsedNow(x.cache.settings.clock)
	expanded := DecompressPayload(payload)
	if expanded.Outcome != "passthrough" {
		x.event("compression", layer, map[string]any{"outcome": expanded.Outcome})
		x.duration("compressionDuration", layer, decompressStarted, map[string]any{"operation": "decompress"})
	}
	start := elapsedNow(x.cache.settings.clock)
	value, err := callSafely(func() (T, error) {
		if codec, ok := x.codec().(ContextCodec[T]); ok {
			return codec.DecodeContext(x.ctx, expanded.Payload)
		}
		return x.codec().Decode(expanded.Payload)
	})
	if err != nil {
		x.errorEvent(layer, "serialization_load", false)
	}
	x.duration("serialization", layer, start, map[string]any{"operation": "load"})
	return value, err
}
func (x *execution[T]) putRemote(value T, fence *uint64, layer string, allowed func() bool) (bool, error) {
	clock := x.cache.settings.clock
	if !x.op.Identity.Tracked {
		fence = nil
	}
	if fence != nil {
		stamp, err := x.writeTimestamp(layer)
		if err != nil {
			return false, err
		}
		if stamp <= int64(*fence) {
			return false, nil
		}
	}
	start := elapsedNow(clock)
	payload, err := callSafely(func() (Payload, error) {
		if codec, ok := x.codec().(ContextCodec[T]); ok {
			return codec.EncodeContext(x.ctx, value)
		}
		return x.codec().Encode(value)
	})
	if err != nil {
		x.errorEvent(layer, "serialization_dump", false)
	}
	x.duration("serialization", layer, start, map[string]any{"operation": "dump"})
	if err != nil {
		return false, err
	}
	x.event("size", layer, map[string]any{"bytes": int64(len(payload.Bytes))})
	if compression := x.cache.settings.compression; compression != nil {
		compressStarted := elapsedNow(clock)
		compressed, compressionErr := CompressPayload(payload, *compression)
		if compressionErr != nil {
			x.errorEvent(layer, "compression", false)
			return false, compressionErr
		}
		payload = compressed.Payload
		x.event("compression", layer, map[string]any{"outcome": compressed.Outcome})
		if compressed.Outcome == "compressed" || compressed.Outcome == "not_smaller" {
			x.duration("compressionDuration", layer, compressStarted, map[string]any{"operation": "compress"})
		}
		if compressed.Outcome == "compressed" {
			x.event("compressionRatio", layer, map[string]any{"value": float64(compressed.StoredBytes) / float64(compressed.OriginalBytes)})
		}
	} else {
		payload = EscapeRawPayload(payload)
	}
	x.event("storedSize", layer, map[string]any{"bytes": int64(len(payload.Bytes))})
	if allowed != nil && !allowed() {
		return false, nil
	}
	stamp, stampErr := x.writeTimestamp(layer)
	if stampErr != nil {
		return false, stampErr
	}
	if fence != nil && uint64(stamp) <= *fence {
		return false, nil
	}
	ttl := x.policy.Remote.TTL
	if x.policy.StaleOnErrorMaxAge > 0 {
		ttl = x.policy.StaleOnErrorMaxAge
	}
	if x.op.Identity.Tracked && ttl > time.Hour {
		ttl = time.Hour
		x.errorEvent(layer, "tracked_ttl_clamped", false)
	}
	_, err = callSafely(func() (struct{}, error) {
		return struct{}{}, x.cache.settings.remote.Write(x.ctx, x.remoteKey, Frame{CreatedAtMS: uint64(stamp), Binary: payload.Binary, Payload: payload.Bytes}, ttl)
	})
	if err != nil {
		x.errorEvent(layer, "cache_write", false)
		return false, err
	}
	return true, nil
}

func (x *execution[T]) writeTimestamp(layer string) (int64, error) {
	stamp := x.cache.settings.clock.WallMS()
	if stamp < 0 || uint64(stamp) > MaxSafeInteger {
		x.errorEvent(layer, "cache_write", false)
		return 0, errors.New("invalid Redis write timestamp")
	}
	return stamp, nil
}

func (x *execution[T]) canRecover(err error) bool {
	predicate := x.op.ShouldRecover
	if predicate == nil {
		predicate = x.cache.settings.shouldRecover
	}
	if predicate == nil {
		var deadline *FallbackTimeoutError
		return errors.As(err, &deadline)
	}
	ok, e := callSafely(func() (bool, error) { return predicate(err) })
	if e != nil {
		x.cache.settings.logger.Warn("DialCache stale recovery predicate threw; recovery was denied", e)
	}
	return e == nil && ok
}
func (x *execution[T]) recoveryEvent(outcome string, age *int64) {
	d := x.labels("")
	d["outcome"] = outcome
	e := Event{Kind: "staleRecovery", Key: x.key, Data: d, Outcome: outcome}
	if cb := x.cache.settings.recoveryOutcome; cb != nil {
		func() { defer func() { recover() }(); cb(e) }()
	}
	x.cache.emit(e)
	if age != nil {
		x.event("recoveryAge", "", map[string]any{"outcome": outcome, "seconds": float64(*age) / 1000})
	}
}
func (x *execution[T]) recover(frame *Frame) (T, bool) {
	var zero T
	if frame == nil {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	maxAge := ms(x.policy.StaleOnErrorMaxAge)
	age, valid := x.frameAge(frame, "remote")
	if !valid || age >= maxAge {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	value, err := x.decode(*frame, "remote")
	if err != nil {
		x.recoveryEvent("deserialization_error", nil)
		return zero, false
	}
	age, valid = x.frameAge(frame, "remote")
	if !valid || age >= maxAge {
		x.recoveryEvent("miss", nil)
		return zero, false
	}
	x.recoveryEvent("served", &age)
	return value, true
}
