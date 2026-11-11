package dialcache

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A waiter whose context ended gets its own error even when the result and the
// source deadline are ready at the same time; select alone picks randomly.
func TestAwaitDeadlinePrefersEndedContext(t *testing.T) {
	clock := newSystemClock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for range 50 {
		p := &pending[string]{done: make(chan struct{}), result: completion[string]{value: "late"}}
		close(p.done)
		started := elapsedNow(clock) - time.Second
		v, err := awaitDeadline(ctx, clock, p, started, 10, func() error { return errors.New("timeout") }, nil)
		if v != "" || !errors.Is(err, context.Canceled) {
			t.Fatalf("awaitDeadline = (%q, %v), want the ended context's error", v, err)
		}
	}
}
