package dialcache

import (
	"context"
	"fmt"
	"time"
)

// ProcessCoalescingState reports the process-scoped single-flight table.
type ProcessCoalescingState struct {
	ActiveLeaders   int
	ActiveFollowers int
	// OldestLeaderAge is zero when no leader is active.
	OldestLeaderAge time.Duration
}
type CoalescingState struct{ Process ProcessCoalescingState }

// GetCoalescingState reports actual process leaders, followers and the
// oldest leader's age for this instance.
func (c *Cache) GetCoalescingState() CoalescingState {
	c.mu.Lock()
	defer c.mu.Unlock()
	state := ProcessCoalescingState{ActiveLeaders: len(c.flights)}
	for _, f := range c.flights {
		state.ActiveFollowers += f.followers
		age := elapsedNow(c.settings.clock) - f.started
		if age < 0 {
			age = 0
		}
		if age > state.OldestLeaderAge {
			state.OldestLeaderAge = age
		}
	}
	return CoalescingState{Process: state}
}

func validateOperation[T any](op Operation[T]) error {
	if err := ValidatePolicy(op.Policy); err != nil {
		return err
	}
	if op.SourceTimeout != NoTimeout && (op.SourceTimeout < 0 || op.SourceTimeout > MaxDeadline || op.SourceTimeout%time.Millisecond != 0) {
		return fmt.Errorf("%w: source timeout must be whole milliseconds up to %s, or NoTimeout", ErrInvalidOperation, MaxDeadline)
	}
	if op.Identity.UseCase == "watermark" {
		return ErrReservedUseCase
	}
	return nil
}

// Cached registers a use case once and returns its typed read-through
// function. The key selector runs only for an enabled call and supplies the
// ID and Args; KeyType, UseCase, Tracked and Namespace come from op.Identity.
// The static policy and source timeout are captured at registration.
func Cached[T, Arg any](cache *Cache, op Operation[T], selectKey func(Arg) (Identity, error), source func(context.Context, Arg) (T, error)) (func(context.Context, Arg) (T, error), error) {
	if cache == nil || selectKey == nil || source == nil {
		return nil, fmt.Errorf("%w: Cached requires a cache, a key selector and a source", ErrInvalidOperation)
	}
	if err := validateOperation(op); err != nil {
		return nil, err
	}
	op.Policy = SnapshotPolicy(op.Policy)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.registered[op.Identity.UseCase] {
		return nil, fmt.Errorf("%w: %s", ErrUseCaseRegistered, op.Identity.UseCase)
	}
	cache.registered[op.Identity.UseCase] = true
	return func(ctx context.Context, arg Arg) (T, error) {
		invocation := op
		invocation.IdentityProvider = func() (Identity, error) {
			key, err := selectKey(arg)
			key.UseCase = op.Identity.UseCase
			key.KeyType = op.Identity.KeyType
			key.Tracked = op.Identity.Tracked
			key.Namespace = op.Identity.Namespace
			return key, err
		}
		return GetOrLoad(ctx, cache, invocation, func(ctx context.Context) (T, error) { return source(ctx, arg) })
	}, nil
}

func (x *execution[T]) codec() Codec[T] {
	if x.op.Codec != nil {
		return x.op.Codec
	}
	return JSONCodec[T]{}
}

// assertValue converts a shared in-process value back to T. A stored nil is
// a value only for an interface T, such as a JSON null cached through any;
// for every other T it belongs to a differently typed operation.
func assertValue[T any](raw any) (T, bool) {
	var zero T
	if raw == nil {
		return zero, any(zero) == nil
	}
	value, ok := raw.(T)
	return value, ok
}
