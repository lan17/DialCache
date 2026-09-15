package dialcache

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// integerFaultClock implements only Clock, not PreciseClock, so every elapsed
// reading, including flight and deadline bookkeeping, goes through ElapsedMS.
type integerFaultClock struct {
	origin time.Time
	fault  atomic.Bool
}

func (c *integerFaultClock) WallMS() int64 { return time.Now().UnixMilli() }
func (c *integerFaultClock) ElapsedMS() int64 {
	if c.fault.Load() {
		panic("controlled clock failure")
	}
	return time.Since(c.origin).Milliseconds()
}

// A clock panic violates the Clock contract and propagates to the caller, but
// it must never leave the cache mutex held. Each call runs on its own
// goroutine with a bound so a regression fails fast instead of hanging the
// package's test binary until its timeout.
func TestPanickingClockCannotDeadlockTheCache(t *testing.T) {
	clock := &integerFaultClock{origin: time.Now()}
	cache := New[int](Options[int]{Clock: clock, LocalCapacity: 2})
	op := Operation{Identity: Identity{KeyType: "clock", ID: "one", UseCase: "local"}, Policy: Policy{LocalTTLMS: 1000}}
	call := func() (value int, err error) {
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer func() {
				if p := recover(); p != nil {
					err = &CallbackPanicError{Value: p}
				}
			}()
			err = cache.Enable(context.Background(), func(ctx context.Context) error {
				var loadErr error
				value, loadErr = cache.GetOrLoad(ctx, op, func(context.Context) (int, error) { return 7, nil })
				return loadErr
			})
		}()
		select {
		case <-done:
			return value, err
		case <-time.After(5 * time.Second):
			t.Fatal("call did not complete; a panicked flight is likely holding the cache mutex")
			return 0, nil
		}
	}
	clock.fault.Store(true)
	if _, err := call(); err == nil {
		t.Fatal("a panicking clock produced a cached or source result")
	}
	clock.fault.Store(false)
	if value, err := call(); err != nil || value != 7 {
		t.Fatalf("cache unusable after a clock panic: value=%d err=%v", value, err)
	}
}
