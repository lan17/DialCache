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

func TestLeaderDeadlineDoesNotEndSharedWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		// A healthy source slower than the leader's deadline.
		load := func(ctx context.Context) (int, error) {
			f.calls.Add(1)
			select {
			case <-time.After(80 * time.Millisecond):
				return 7, nil
			case <-ctx.Done():
				return 0, ctx.Err()
			}
		}
		start := time.Now()
		leaderCtx, cancelLeader := context.WithTimeout(ctx, 20*time.Millisecond)
		defer cancelLeader()
		followerCtx, cancelFollower := context.WithTimeout(ctx, time.Second)
		defer cancelFollower()
		leader := make(chan error, 1)
		go func() { _, err := f.get(leaderCtx, load); leader <- err }()
		synctest.Wait()
		v, err := f.get(followerCtx, load)
		if err := <-leader; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("leader error = %v, want its own deadline", err)
		}
		if v != 7 || err != nil || f.calls.Load() != 1 || time.Since(start) != 80*time.Millisecond {
			t.Fatalf("follower = (%d, %v) after %v and %d source calls; want (7, nil) from the shared 80ms source", v, err, time.Since(start), f.calls.Load())
		}
	})
}

func TestLoaderDeadlineErrorDoesNotRestartWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		gate := make(chan struct{})
		// The loader's own client timed out; the callers still have time.
		load := func(context.Context) (int, error) { f.calls.Add(1); <-gate; return 0, context.DeadlineExceeded }
		callerCtx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		leader := make(chan error, 1)
		go func() { _, err := f.get(callerCtx, load); leader <- err }()
		synctest.Wait()
		follower := make(chan error, 1)
		go func() { _, err := f.get(callerCtx, load); follower <- err }()
		synctest.Wait()
		close(gate)
		for name, got := range map[string]chan error{"leader": leader, "follower": follower} {
			if err := <-got; !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("%s error = %v, want the loader's error", name, err)
			}
		}
		if f.calls.Load() != 1 {
			t.Fatalf("source calls = %d, want 1: a loader's deadline error must not start fresh work", f.calls.Load())
		}
	})
}

// stallingWriteRemote misses on read, and its writes wait for their context,
// like a stalled Redis SET on a client that honors ctx.
type stallingWriteRemote struct{ writes atomic.Int64 }

func (r *stallingWriteRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
}
func (r *stallingWriteRemote) Write(ctx context.Context, _ string, _ Frame, _ time.Duration) error {
	r.writes.Add(1)
	<-ctx.Done()
	return ctx.Err()
}
func (r *stallingWriteRemote) Invalidate(context.Context, string, int64, int64) error { return nil }

func TestStalledWriteEndsWhenNoCallerWaits(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		remote := &stallingWriteRemote{}
		cache := MustNew(WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second))
		op := Operation[int]{Identity: Identity{Namespace: "lifetime", KeyType: "id", ID: "hot", UseCase: "get"}, Policy: Policy{RemoteTTL: time.Minute}}
		ctx, done := cache.Enable(context.Background())
		defer done()
		callerCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		if _, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (int, error) { return 7, nil }); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("caller error = %v, want its own deadline while the write stalls", err)
		}
		synctest.Wait()
		if remote.writes.Load() != 1 || cache.GetCoalescingState().Process.ActiveLeaders != 0 {
			t.Fatalf("after the only caller left: writes = %d, published flights = %d; want the stalled write cancelled and the flight gone", remote.writes.Load(), cache.GetCoalescingState().Process.ActiveLeaders)
		}
	})
}

func TestCallerCancelledAtEntryStartsNoSharedWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := f.get(cancelled, func(context.Context) (int, error) { f.calls.Add(1); return 7, nil }); !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want the caller's cancellation", err)
		}
		synctest.Wait()
		if f.calls.Load() != 0 {
			t.Fatalf("source calls = %d, want 0 for a caller that had already left", f.calls.Load())
		}
	})
}

func TestRequestLeavingKeepsProcessWorkAnotherRequestWaitsFor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{RequestLocal: true})
		load := func(context.Context) (int, error) {
			f.calls.Add(1)
			time.Sleep(80 * time.Millisecond)
			return 7, nil
		}
		// Two requests share one process flight; the first request leads it and leaves.
		ctxB, doneB := f.cache.Enable(context.Background())
		defer doneB()
		ctxA, doneA := f.cache.Enable(context.Background())
		defer doneA()
		shortB, cancelB := context.WithTimeout(ctxB, 20*time.Millisecond)
		defer cancelB()
		longA, cancelA := context.WithTimeout(ctxA, time.Second)
		defer cancelA()
		leader := make(chan error, 1)
		go func() { _, err := f.get(shortB, load); leader <- err }()
		synctest.Wait()
		v, err := f.get(longA, load)
		if err := <-leader; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("request B error = %v, want its own deadline", err)
		}
		if v != 7 || err != nil || f.calls.Load() != 1 {
			t.Fatalf("request A = (%d, %v) after %d source calls; want (7, nil) from the shared process work", v, err, f.calls.Load())
		}
	})
}

func TestSourceThatIgnoresCancellationIsNotStartedTwice(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var writes atomic.Int64
		remote := boundaryRemote{
			read: func(context.Context) (ReadResult, error) {
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			},
			write: func(Frame) error { writes.Add(1); return nil },
		}
		cache := MustNew(WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second))
		op := Operation[int]{Identity: Identity{Namespace: "lifetime", KeyType: "id", ID: "sparse", UseCase: "get"}, Policy: Policy{RemoteTTL: time.Minute}, SourceTimeout: NoTimeout}
		ctx, done := cache.Enable(context.Background())
		defer done()
		var calls atomic.Int64
		release := make(chan struct{})
		// The first query hangs and ignores its context; later ones return 8.
		load := func(context.Context) (int, error) {
			if calls.Add(1) == 1 {
				<-release
				return 7, nil
			}
			return 8, nil
		}
		for caller := range 2 {
			short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
			if _, err := GetOrLoad(short, cache, op, load); !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("caller %d error = %v, want its own deadline", caller, err)
			}
			cancel()
			synctest.Wait()
		}
		if calls.Load() != 1 {
			t.Fatalf("source calls while the first one still runs = %d, want 1", calls.Load())
		}
		close(release)
		synctest.Wait()
		if writes.Load() != 0 || cache.GetCoalescingState().Process.ActiveLeaders != 0 {
			t.Fatalf("after the abandoned source returned: writes = %d, published flights = %d; want 0 and 0", writes.Load(), cache.GetCoalescingState().Process.ActiveLeaders)
		}
		if v, err := GetOrLoad(ctx, cache, op, load); v != 8 || err != nil || calls.Load() != 2 {
			t.Fatalf("next caller = (%d, %v) after %d source calls; want (8, nil) from fresh work after 2", v, err, calls.Load())
		}
	})
}

func TestFollowerOfCancelledWorkRetriesWithItsOwnContext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		release := make(chan struct{})
		// The first query notices its cancellation only when released.
		load := func(ctx context.Context) (int, error) {
			if f.calls.Add(1) == 1 {
				<-release
				return 0, ctx.Err()
			}
			return 7, nil
		}
		short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
		defer cancel()
		if _, err := f.get(short, load); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("first caller error = %v, want its own deadline", err)
		}
		long, cancelLong := context.WithTimeout(ctx, time.Second)
		defer cancelLong()
		follower := make(chan error, 1)
		var v int
		go func() { var err error; v, err = f.get(long, load); follower <- err }()
		synctest.Wait()
		close(release)
		if err := <-follower; v != 7 || err != nil || f.calls.Load() != 2 {
			t.Fatalf("follower = (%d, %v) after %d source calls; want (7, nil) from fresh work", v, err, f.calls.Load())
		}
	})
}

func TestCancelledRequestFlightCancelsTheProcessFlightItWaitsFor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{RequestLocal: true})
		defer close(f.release)
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		// A cancel-only caller: no deadline reaches the process flight.
		cancelled, cancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() { _, err := f.get(cancelled, f.hang); result <- err }()
		synctest.Wait()
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("caller error = %v, want its own cancellation", err)
		}
		synctest.Wait()
		if live, leaders := f.live.Load(), f.cache.GetCoalescingState().Process.ActiveLeaders; live != 0 || leaders != 0 {
			t.Fatalf("after the request flight lost its only waiter: live loaders = %d, published process flights = %d; want 0 and 0", live, leaders)
		}
	})
}

func TestAbandonedWorkFillsNoLocalOrRequestCache(t *testing.T) {
	for name, policy := range map[string]Policy{"local": {LocalTTL: time.Minute}, "request": {RequestLocal: true}} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cache := MustNew(WithoutCompression())
				op := Operation[int]{Identity: Identity{Namespace: "lifetime", KeyType: "id", ID: "fill", UseCase: "get"}, Policy: policy, SourceTimeout: NoTimeout}
				ctx, done := cache.Enable(context.Background())
				defer done()
				release := make(chan struct{})
				var calls atomic.Int64
				// The first query ignores its context and returns 7 after its
				// only caller left; later queries return 8.
				load := func(context.Context) (int, error) {
					if calls.Add(1) == 1 {
						<-release
						return 7, nil
					}
					return 8, nil
				}
				short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
				defer cancel()
				if _, err := GetOrLoad(short, cache, op, load); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("first caller error = %v, want its own deadline", err)
				}
				close(release)
				synctest.Wait()
				if v, err := GetOrLoad(ctx, cache, op, load); v != 8 || err != nil {
					t.Fatalf("next caller = (%d, %v), want (8, nil): abandoned work must not fill the cache", v, err)
				}
			})
		})
	}
}

// blockingCodec holds Encode until the test releases it.
type blockingCodec struct{ entered, release chan struct{} }

func (c blockingCodec) Encode(v int) (Payload, error) {
	close(c.entered)
	<-c.release
	return JSONCodec[int]{}.Encode(v)
}
func (c blockingCodec) Decode(p Payload) (int, error) { return JSONCodec[int]{}.Decode(p) }

func TestCallerLeavingDuringEncodeStopsTheWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var writes atomic.Int64
		remote := boundaryRemote{
			read: func(context.Context) (ReadResult, error) {
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			},
			write: func(Frame) error { writes.Add(1); return nil },
		}
		var clamps atomic.Int64
		observe := func(e Event) {
			if e.Kind == "error" && e.Data["error"] == "tracked_ttl_clamped" {
				clamps.Add(1)
			}
		}
		cache := MustNew(WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second), WithObserver(observe))
		codec := blockingCodec{entered: make(chan struct{}), release: make(chan struct{})}
		op := Operation[int]{Identity: Identity{Namespace: "lifetime", KeyType: "id", ID: "encode", UseCase: "get", Tracked: true}, Policy: Policy{RemoteTTL: 2 * time.Hour}, Codec: codec}
		ctx, done := cache.Enable(context.Background())
		defer done()
		callerCtx, cancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() {
			_, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (int, error) { return 7, nil })
			result <- err
		}()
		<-codec.entered
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("caller error = %v, want its own cancellation", err)
		}
		close(codec.release)
		synctest.Wait()
		if writes.Load() != 0 || clamps.Load() != 0 {
			t.Fatalf("writes = %d, TTL clamp events = %d; want 0 and 0 after the only caller left during encoding", writes.Load(), clamps.Load())
		}
	})
}

// nilUnwrapError is a typed-nil error whose Unwrap dereferences its receiver,
// so errors.As on it panics.
type nilUnwrapError struct{ inner error }

func (e *nilUnwrapError) Error() string { return "nil unwrap" }
func (e *nilUnwrapError) Unwrap() error { return e.inner }

func TestPanickingErrorFromAbandonedWorkDoesNotCrash(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		load := func(ctx context.Context) (int, error) {
			<-ctx.Done()
			var err *nilUnwrapError
			return 0, err
		}
		callerCtx, cancel := context.WithCancel(ctx)
		caller := make(chan error, 1)
		go func() { _, err := f.get(callerCtx, load); caller <- err }()
		synctest.Wait()
		cancel()
		if err := <-caller; !errors.Is(err, context.Canceled) {
			t.Fatalf("caller error = %v, want its own cancellation", err)
		}
		// The abandoned work returns its error now; a panic while the flight
		// classifies it would end the process.
		synctest.Wait()
		if v, err := f.get(ctx, func(context.Context) (int, error) { return 7, nil }); v != 7 || err != nil {
			t.Fatalf("next call = (%d, %v), want (7, nil) from fresh work", v, err)
		}
	})
}

func TestCallerLeavingDuringTheTTLClampEventStopsTheWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var writes atomic.Int64
		remote := boundaryRemote{
			read: func(context.Context) (ReadResult, error) {
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			},
			write: func(Frame) error { writes.Add(1); return nil },
		}
		entered, release := make(chan struct{}), make(chan struct{})
		observe := func(e Event) {
			if e.Kind == "error" && e.Data["error"] == "tracked_ttl_clamped" {
				close(entered)
				<-release
			}
		}
		cache := MustNew(WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second), WithObserver(observe))
		op := Operation[int]{Identity: Identity{Namespace: "lifetime", KeyType: "id", ID: "clamp", UseCase: "get", Tracked: true}, Policy: Policy{RemoteTTL: 2 * time.Hour}}
		ctx, done := cache.Enable(context.Background())
		defer done()
		callerCtx, cancel := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() {
			_, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (int, error) { return 7, nil })
			result <- err
		}()
		<-entered
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("caller error = %v, want its own cancellation", err)
		}
		close(release)
		synctest.Wait()
		if writes.Load() != 0 {
			t.Fatalf("writes = %d, want 0 after the only caller left during the TTL clamp event", writes.Load())
		}
	})
}

func TestFollowerOfCancelledWorkThatPanicsRetries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newLifetimeFixture(Policy{StaleOnErrorMaxAge: Ptr(time.Hour)})
		ctx, done := f.cache.Enable(context.Background())
		defer done()
		gate := make(chan struct{})
		// Cancelled, the source returns an error that panics when the stale
		// recovery check classifies it.
		load := func(ctx context.Context) (int, error) {
			if f.calls.Add(1) > 1 {
				return 7, nil
			}
			<-ctx.Done()
			<-gate
			var err *nilUnwrapError
			return 0, err
		}
		leaderCtx, cancelLeader := context.WithCancel(ctx)
		leader := make(chan error, 1)
		go func() { _, err := f.get(leaderCtx, load); leader <- err }()
		synctest.Wait()
		cancelLeader()
		if err := <-leader; !errors.Is(err, context.Canceled) {
			t.Fatalf("leader error = %v, want its own cancellation", err)
		}
		type result struct {
			v   int
			err error
		}
		follower := make(chan result, 1)
		go func() { v, err := f.get(ctx, load); follower <- result{v, err} }()
		synctest.Wait()
		close(gate)
		if got := <-follower; got.v != 7 || got.err != nil || f.calls.Load() != 2 {
			t.Fatalf("follower = (%d, %v) after %d source calls; want (7, nil) from fresh work after the cancelled work panicked", got.v, got.err, f.calls.Load())
		}
	})
}
