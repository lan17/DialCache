package dialcache

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// notFoundError stands in for a "not found" error that a Go source returns
// for a normal outcome.
type notFoundError struct{ id string }

func (e *notFoundError) Error() string { return "not found: " + e.id }

// expectedErrorFixture caches in every layer over a remote miss. It counts
// source calls, predicate calls, remote writes and the fallback error and
// timer events.
type expectedErrorFixture struct {
	cache                                                              *Cache
	op                                                                 Operation[int]
	logger                                                             *boundaryLogger
	sourceCalls, predicateCalls, writes, fallbackErrors, fallbackTimer atomic.Int64
	seen                                                               error
}

func newExpectedErrorFixture(policy Policy, predicate func(error) bool) *expectedErrorFixture {
	f := &expectedErrorFixture{logger: &boundaryLogger{}}
	remote := boundaryRemote{
		read: func(context.Context) (ReadResult, error) {
			return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
		},
		write: func(Frame) error { f.writes.Add(1); return nil },
	}
	f.cache = MustNew(WithRemote(remote), WithoutCompression(), WithLogger(f.logger), WithObserver(func(e Event) {
		if e.Kind == "error" && e.Data["error"] == "fallback" && e.Data["inFallback"] == true {
			f.fallbackErrors.Add(1)
		}
		if e.Kind == "fallback" {
			f.fallbackTimer.Add(1)
		}
	}))
	f.op = Operation[int]{Identity: Identity{Namespace: "expected", KeyType: "user", ID: "1", UseCase: "profile"}, Policy: policy}
	if predicate != nil {
		f.op.ExpectedError = func(err error) bool {
			f.predicateCalls.Add(1)
			f.seen = err
			return predicate(err)
		}
	}
	return f
}

func (f *expectedErrorFixture) get(ctx context.Context, load func(context.Context) (int, error)) (int, error) {
	return GetOrLoad(ctx, f.cache, f.op, func(ctx context.Context) (int, error) {
		f.sourceCalls.Add(1)
		return load(ctx)
	})
}

func TestExpectedErrorRecordsNoFallbackError(t *testing.T) {
	isNotFound := func(err error) bool { var nf *notFoundError; return errors.As(err, &nf) }
	for _, c := range []struct {
		name           string
		predicate      func(error) bool
		fallbackErrors int64
		warnings       int64
	}{
		{"expected", isNotFound, 0, 0},
		{"not expected", func(error) bool { return false }, 2, 0},
		{"nil", nil, 2, 0},
		{"panicking", func(error) bool { panic("predicate failure") }, 2, 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newExpectedErrorFixture(Policy{RequestLocal: true, LocalTTL: time.Second, RemoteTTL: time.Minute}, c.predicate)
			returned := fmt.Errorf("profile: %w", &notFoundError{id: "1"})
			ctx, done := f.cache.Enable(context.Background())
			defer done()
			for range 2 {
				_, err := f.get(ctx, func(context.Context) (int, error) { return 0, returned })
				var nf *notFoundError
				if err != returned || !errors.As(err, &nf) {
					t.Fatalf("err = %v; want the source's error unchanged", err)
				}
			}
			if f.sourceCalls.Load() != 2 || f.writes.Load() != 0 {
				t.Fatalf("source calls = %d, remote writes = %d; want 2 and 0: the error is cached in no layer", f.sourceCalls.Load(), f.writes.Load())
			}
			if f.fallbackErrors.Load() != c.fallbackErrors || f.fallbackTimer.Load() != 2 {
				t.Fatalf("fallback errors = %d, fallback timer = %d; want %d and 2", f.fallbackErrors.Load(), f.fallbackTimer.Load(), c.fallbackErrors)
			}
			if f.logger.warnings.Load() != c.warnings {
				t.Fatalf("warnings = %d; want %d", f.logger.warnings.Load(), c.warnings)
			}
			if c.predicate != nil && f.seen != error(returned) {
				t.Fatalf("predicate saw %v; want the source's error unchanged", f.seen)
			}
		})
	}
}

func TestExpectedErrorAlwaysCountsDeadlinesAndPanics(t *testing.T) {
	for _, c := range []struct {
		name   string
		load   func(context.Context) (int, error)
		target any
	}{
		{"deadline", func(ctx context.Context) (int, error) { <-ctx.Done(); return 0, ctx.Err() }, new(*FallbackTimeoutError)},
		{"panic", func(context.Context) (int, error) { panic("source failure") }, new(*CallbackPanicError)},
	} {
		t.Run(c.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newExpectedErrorFixture(Policy{LocalTTL: time.Second, RemoteTTL: time.Minute}, func(error) bool { return true })
				f.op.SourceTimeout = 10 * time.Millisecond
				ctx, done := f.cache.Enable(context.Background())
				defer done()
				if _, err := f.get(ctx, c.load); !errors.As(err, c.target) {
					t.Fatalf("err = %v; want %T", err, c.target)
				}
				if f.fallbackErrors.Load() != 1 || f.predicateCalls.Load() != 0 {
					t.Fatalf("fallback errors = %d, predicate calls = %d; want 1 and 0", f.fallbackErrors.Load(), f.predicateCalls.Load())
				}
			})
		})
	}
}

func TestExpectedErrorReachesCoalescedFollowers(t *testing.T) {
	for _, c := range []struct {
		expected       bool
		fallbackErrors int64
	}{{true, 0}, {false, 1}} {
		t.Run(fmt.Sprint(c.expected), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newExpectedErrorFixture(Policy{LocalTTL: time.Second, RemoteTTL: time.Minute}, func(error) bool { return c.expected })
				ctx, done := f.cache.Enable(context.Background())
				defer done()
				returned := &notFoundError{id: "1"}
				gate := make(chan struct{})
				load := func(context.Context) (int, error) { <-gate; return 0, returned }
				results := make(chan error, 3)
				for range 3 {
					go func() { _, err := f.get(ctx, load); results <- err }()
					synctest.Wait()
				}
				close(gate)
				for range 3 {
					if err := <-results; err != error(returned) {
						t.Fatalf("err = %v; want the leader's error for every caller", err)
					}
				}
				if f.sourceCalls.Load() != 1 || f.predicateCalls.Load() != 1 || f.fallbackErrors.Load() != c.fallbackErrors || f.fallbackTimer.Load() != 1 {
					t.Fatalf("source calls = %d, predicate calls = %d, fallback errors = %d, fallback timer = %d; want 1, 1, %d and 1",
						f.sourceCalls.Load(), f.predicateCalls.Load(), f.fallbackErrors.Load(), f.fallbackTimer.Load(), c.fallbackErrors)
				}
			})
		})
	}
}
