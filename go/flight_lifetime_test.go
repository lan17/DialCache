package dialcache

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// lifetimeFixture is a coalescing cache with a remote miss and a loader that
// waits for its context to end, like a database query that honors ctx.
type lifetimeFixture struct {
	cache   *Cache
	op      Operation[int]
	live    atomic.Int64
	calls   atomic.Int64
	release chan struct{}
}

func newLifetimeFixture(policy Policy) *lifetimeFixture {
	remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
		return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
	}}
	policy.RemoteTTL = time.Minute
	return &lifetimeFixture{
		cache: MustNew(WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second)),
		op: Operation[int]{
			Identity:      Identity{Namespace: "lifetime", KeyType: "id", ID: "k", UseCase: "get"},
			Policy:        policy,
			SourceTimeout: NoTimeout,
		},
		release: make(chan struct{}),
	}
}

func (f *lifetimeFixture) hang(ctx context.Context) (int, error) {
	f.calls.Add(1)
	f.live.Add(1)
	defer f.live.Add(-1)
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-f.release:
		return 0, errors.New("released by the test")
	}
}

func (f *lifetimeFixture) get(ctx context.Context, load func(context.Context) (int, error)) (int, error) {
	return GetOrLoad(ctx, f.cache, f.op, load)
}

func TestAbandonedFlightIsCancelledAndUnpublished(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		defer close(f.release)
		ctx, done := f.cache.Enable(context.Background())
		defer done()

		short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
		defer cancel()
		if _, err := f.get(short, f.hang); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("caller error = %v, want its own deadline", err)
		}
		synctest.Wait()
		if live, leaders := f.live.Load(), f.cache.GetCoalescingState().Process.ActiveLeaders; live != 0 || leaders != 0 {
			t.Fatalf("after the only waiter left: live loaders = %d, published flights = %d; want 0 and 0", live, leaders)
		}

		later, cancelLater := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancelLater()
		v, err := f.get(later, func(context.Context) (int, error) { f.calls.Add(1); return 7, nil })
		if v != 7 || err != nil || f.calls.Load() != 2 {
			t.Fatalf("later caller = (%d, %v) after %d source calls; want a fresh flight that returns (7, nil) after 2", v, err, f.calls.Load())
		}
	})
}

func TestSharedWorkRunsUntilItsLastWaiterLeaves(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		defer close(f.release)
		ctx, done := f.cache.Enable(context.Background())
		defer done()

		// Cancel-only callers: no deadline bounds the work, only their waits.
		leaderCtx, cancelLeader := context.WithCancel(ctx)
		followerCtx, cancelFollower := context.WithCancel(ctx)
		leader, follower := make(chan error, 1), make(chan error, 1)
		go func() { _, err := f.get(leaderCtx, f.hang); leader <- err }()
		synctest.Wait()
		go func() { _, err := f.get(followerCtx, f.hang); follower <- err }()
		synctest.Wait()

		cancelLeader()
		if err := <-leader; !errors.Is(err, context.Canceled) {
			t.Fatalf("leader error = %v, want its own cancellation", err)
		}
		synctest.Wait()
		if live := f.live.Load(); live != 1 {
			t.Fatalf("live loaders after the leader left = %d, want 1 while the follower waits", live)
		}

		cancelFollower()
		if err := <-follower; !errors.Is(err, context.Canceled) {
			t.Fatalf("follower error = %v, want its own cancellation", err)
		}
		synctest.Wait()
		if live, leaders := f.live.Load(), f.cache.GetCoalescingState().Process.ActiveLeaders; live != 0 || leaders != 0 || f.calls.Load() != 1 {
			t.Fatalf("after the last waiter left: live loaders = %d, published flights = %d, source calls = %d; want 0, 0, 1", live, leaders, f.calls.Load())
		}
	})
}

func TestAbandonedRequestFlightCancelsTheProcessFlightItWaitsFor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{RequestLocal: true})
		defer close(f.release)
		ctx, done := f.cache.Enable(context.Background())
		defer done()

		short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
		defer cancel()
		if _, err := f.get(short, f.hang); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("caller error = %v, want its own deadline", err)
		}
		synctest.Wait()
		if live, leaders := f.live.Load(), f.cache.GetCoalescingState().Process.ActiveLeaders; live != 0 || leaders != 0 {
			t.Fatalf("after the request flight lost its only waiter: live loaders = %d, published process flights = %d; want 0 and 0", live, leaders)
		}
	})
}
