package dialcache_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/lan17/DialCache/go"
)

// contextRemote is an in-memory Remote whose reads and writes can be held
// until the test releases them.
type contextRemote struct {
	mu        sync.Mutex
	values    map[string][]byte
	holdRead  bool
	readDone  chan error
	holdWrite chan struct{}
}

func newContextRemote() *contextRemote {
	return &contextRemote{values: map[string][]byte{}, readDone: make(chan error, 1)}
}

func (r *contextRemote) Read(ctx context.Context, key, watermark string) (ReadResult, error) {
	if r.holdRead {
		if _, ok := ctx.Deadline(); ok {
			r.readDone <- errors.New("read context has a deadline")
			return ReadResult{}, nil
		}
		<-ctx.Done()
		r.readDone <- ctx.Err()
		return ReadResult{}, ctx.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return DecodeFrame(r.values[key], watermark != "", nil), nil
}

func (r *contextRemote) Write(ctx context.Context, key string, frame Frame, _ time.Duration) error {
	if r.holdWrite != nil {
		<-r.holdWrite
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values[key] = raw
	return nil
}

func (r *contextRemote) Invalidate(context.Context, string, int64, int64) error { return nil }

func contextOperation(id string, policy Policy) Operation[string] {
	return Operation[string]{Identity: Identity{Namespace: "context", KeyType: "item", ID: id, UseCase: "lookup"}, Policy: policy}
}

func waitForFollowers(t *testing.T, cache *Cache, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for cache.GetCoalescingState().Process.ActiveFollowers != n {
		if time.Now().After(deadline) {
			t.Fatalf("followers = %d, want %d", cache.GetCoalescingState().Process.ActiveFollowers, n)
		}
		time.Sleep(time.Millisecond)
	}
}

type contextResult struct {
	value string
	err   error
}

func receive(t *testing.T, results <-chan contextResult) contextResult {
	t.Helper()
	select {
	case r := <-results:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("caller did not return")
		return contextResult{}
	}
}

func TestContextFollowerReturnsAtItsOwnDeadline(t *testing.T) {
	cache := MustNew(WithRemote(newContextRemote()))
	op := contextOperation("follower-deadline", Policy{RemoteTTL: time.Minute})
	release := make(chan struct{})
	load := func(context.Context) (string, error) { <-release; return "value", nil }
	ctx, done := cache.Enable(context.Background())
	defer done()

	leader := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(ctx, cache, op, load); leader <- contextResult{v, err} }()
	waitForFollowers(t, cache, 0)
	for cache.GetCoalescingState().Process.ActiveLeaders != 1 {
		time.Sleep(time.Millisecond)
	}
	followerCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	follower := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(followerCtx, cache, op, load); follower <- contextResult{v, err} }()

	if r := receive(t, follower); !errors.Is(r.err, context.DeadlineExceeded) {
		t.Fatalf("follower = %+v, want its own deadline", r)
	}
	if n := cache.GetCoalescingState().Process.ActiveFollowers; n != 0 {
		t.Fatalf("a follower that left still counts: %d", n)
	}
	close(release)
	if r := receive(t, leader); r.value != "value" || r.err != nil {
		t.Fatalf("leader = %+v", r)
	}
}

func TestContextLeaderCancellationDoesNotFailFollowers(t *testing.T) {
	cache := MustNew(WithRemote(newContextRemote()))
	op := contextOperation("leader-cancel", Policy{RemoteTTL: time.Minute})
	release := make(chan struct{})
	sourceErr := make(chan error, 1)
	load := func(ctx context.Context) (string, error) {
		<-release
		sourceErr <- ctx.Err()
		return "value", nil
	}
	ctx, done := cache.Enable(context.Background())
	defer done()
	leaderCtx, cancelLeader := context.WithCancel(ctx)

	leader := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(leaderCtx, cache, op, load); leader <- contextResult{v, err} }()
	for cache.GetCoalescingState().Process.ActiveLeaders != 1 {
		time.Sleep(time.Millisecond)
	}
	follower := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(ctx, cache, op, load); follower <- contextResult{v, err} }()
	waitForFollowers(t, cache, 1)

	cancelLeader()
	if r := receive(t, leader); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("leader = %+v, want its own cancellation", r)
	}
	close(release)
	if err := <-sourceErr; err != nil {
		t.Fatalf("leader cancellation reached the shared source: %v", err)
	}
	if r := receive(t, follower); r.value != "value" || r.err != nil {
		t.Fatalf("follower = %+v, want the shared value", r)
	}
}

func TestContextSourceTimeoutCancelsSourceContext(t *testing.T) {
	cache := MustNew(WithRemote(newContextRemote()))
	op := contextOperation("source-timeout", Policy{RemoteTTL: time.Minute})
	op.SourceTimeout = 50 * time.Millisecond
	sourceErr := make(chan error, 1)
	hasDeadline := make(chan bool, 1)
	load := func(ctx context.Context) (string, error) {
		_, ok := ctx.Deadline()
		hasDeadline <- ok
		<-ctx.Done()
		sourceErr <- ctx.Err()
		return "", ctx.Err()
	}
	ctx, done := cache.Enable(context.Background())
	defer done()

	_, err := GetOrLoad(ctx, cache, op, load)
	var timeout *FallbackTimeoutError
	if !errors.As(err, &timeout) {
		t.Fatalf("err = %v, want FallbackTimeoutError", err)
	}
	if !<-hasDeadline {
		t.Fatal("source context has no deadline")
	}
	select {
	case err := <-sourceErr:
		if err == nil {
			t.Fatal("source context was not cancelled")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the source deadline did not cancel the source context")
	}
}

func TestContextCallerCancellationEndsItsSourceWithoutRecovery(t *testing.T) {
	remote := newContextRemote()
	cache := MustNew(WithRemote(remote), WithStaleRecovery(func(error) (bool, error) { return true, nil }))
	op := contextOperation("caller-cancel", Policy{RemoteTTL: time.Second, StaleOnErrorMaxAge: Ptr(time.Minute), Coalesce: Ptr(false)})
	_, key, _, err := op.Identity.Keys()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := JSONCodec[string]{}.Encode("stale")
	if err != nil {
		t.Fatal(err)
	}
	stale := Frame{CreatedAtMS: uint64(time.Now().Add(-5 * time.Second).UnixMilli()), Payload: payload.Bytes}
	if err := remote.Write(context.Background(), key, stale, time.Minute); err != nil {
		t.Fatal(err)
	}
	sourceErr := make(chan error, 1)
	load := func(ctx context.Context) (string, error) {
		<-ctx.Done()
		sourceErr <- ctx.Err()
		return "", ctx.Err()
	}
	ctx, done := cache.Enable(context.Background())
	defer done()
	callerCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()

	v, err := GetOrLoad(callerCtx, cache, op, load)
	if v != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("caller = (%q, %v), want its own deadline and no recovered value", v, err)
	}
	select {
	case err := <-sourceErr:
		if err == nil {
			t.Fatal("source context was not cancelled")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the caller leaving did not cancel its source context")
	}
}

func TestContextTimedOutReadReleasesItsWait(t *testing.T) {
	remote := newContextRemote()
	remote.holdRead = true
	cache := MustNew(WithRemote(remote), WithRemoteReadTimeout(20*time.Millisecond))
	op := contextOperation("read-timeout", Policy{RemoteTTL: time.Minute})
	ctx, done := cache.Enable(context.Background())
	defer done()

	v, err := GetOrLoad(ctx, cache, op, func(context.Context) (string, error) { return "value", nil })
	if v != "value" || err != nil {
		t.Fatalf("caller = (%q, %v)", v, err)
	}
	select {
	case err := <-remote.readDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("read ended with %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a timed-out read kept waiting")
	}
}

func TestContextUncoalescedCallerStopsWaitingForRead(t *testing.T) {
	remote := newContextRemote()
	remote.holdRead = true
	cache := MustNew(WithRemote(remote), WithRemoteReadTimeout(5*time.Second))
	op := contextOperation("uncoalesced-read", Policy{RemoteTTL: time.Minute, Coalesce: Ptr(false)})
	ctx, done := cache.Enable(context.Background())
	defer done()
	callerCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()

	var called atomic.Bool
	results := make(chan contextResult, 1)
	go func() {
		v, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (string, error) { called.Store(true); return "value", nil })
		results <- contextResult{v, err}
	}()
	if r := receive(t, results); r.value != "" || !errors.Is(r.err, context.DeadlineExceeded) {
		t.Fatalf("caller = %+v, want its own deadline during the read", r)
	}
	if called.Load() {
		t.Fatal("source ran for a caller that had stopped waiting")
	}
}

func TestContextEndedCallerGetsItsErrorOverAReadyResult(t *testing.T) {
	t.Run("follower", func(t *testing.T) {
		for range 20 {
			release := make(chan struct{})
			leader := make(chan contextResult, 1)
			followerCtx, cancelFollower := context.WithCancel(context.Background())
			defer cancelFollower()
			observe := func(e Event) {
				if e.Kind != "coalesced" {
					return
				}
				// Make both the flight result and the follower's cancellation
				// ready before the follower starts waiting.
				cancelFollower()
				close(release)
				<-leader
				leader <- contextResult{}
			}
			cache := MustNew(WithRemote(newContextRemote()), WithObserver(observe))
			op := contextOperation("both-ready-follower", Policy{RemoteTTL: time.Minute})
			load := func(context.Context) (string, error) { <-release; return "value", nil }
			ctx, done := cache.Enable(context.Background())
			go func() { v, err := GetOrLoad(ctx, cache, op, load); leader <- contextResult{v, err} }()
			for cache.GetCoalescingState().Process.ActiveLeaders != 1 {
				time.Sleep(time.Millisecond)
			}
			followerCtx, closeFollower := cache.Enable(followerCtx)
			v, err := GetOrLoad(followerCtx, cache, op, load)
			closeFollower()
			done()
			if v != "" || !errors.Is(err, context.Canceled) {
				t.Fatalf("follower = (%q, %v), want its own cancellation", v, err)
			}
		}
	})
	t.Run("source", func(t *testing.T) {
		cache := MustNew(WithRemote(newContextRemote()))
		op := contextOperation("both-ready-source", Policy{RemoteTTL: time.Minute, Coalesce: Ptr(false)})
		for range 20 {
			ctx, done := cache.Enable(context.Background())
			callerCtx, cancel := context.WithCancel(ctx)
			v, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (string, error) { cancel(); return "value", nil })
			done()
			if v != "" || !errors.Is(err, context.Canceled) {
				t.Fatalf("caller = (%q, %v), want its own cancellation", v, err)
			}
		}
	})
}

func TestContextServedShadowOutlivesCaller(t *testing.T) {
	outcomes := make(chan string, 4)
	cache := MustNew(WithRemote(newContextRemote()), WithShadowOutcomes(func(e Event) { outcomes <- e.Outcome }))
	op := contextOperation("served-shadow", Policy{RemoteTTL: time.Minute, Shadow: &ShadowPolicy{Ramp: Ptr(100.0)}})
	ctx, done := cache.Enable(context.Background())
	defer done()
	if _, err := GetOrLoad(ctx, cache, op, func(context.Context) (string, error) { return "value", nil }); err != nil {
		t.Fatal(err)
	}

	callerCtx, cancel := context.WithCancel(ctx)
	returned := make(chan struct{})
	load := func(ctx context.Context) (string, error) {
		<-returned
		return "value", ctx.Err()
	}
	if v, err := GetOrLoad(callerCtx, cache, op, load); v != "value" || err != nil {
		t.Fatalf("hit = (%q, %v)", v, err)
	}
	cancel()
	close(returned)
	select {
	case outcome := <-outcomes:
		if outcome != "match" {
			t.Fatalf("shadow outcome = %q, want match after the caller left", outcome)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no shadow verdict")
	}
}

func TestContextDarkShadowFillOutlivesCaller(t *testing.T) {
	remote := newContextRemote()
	remote.holdWrite = make(chan struct{})
	outcomes := make(chan string, 4)
	cache := MustNew(WithRemote(remote), WithShadowOutcomes(func(e Event) { outcomes <- e.Outcome }))
	op := contextOperation("dark-shadow", Policy{RemoteTTL: time.Minute, RemoteRamp: Ptr(0.0), Shadow: &ShadowPolicy{Ramp: Ptr(100.0)}})
	ctx, done := cache.Enable(context.Background())
	defer done()
	callerCtx, cancel := context.WithCancel(ctx)

	if v, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (string, error) { return "value", nil }); v != "value" || err != nil {
		t.Fatalf("dark call = (%q, %v)", v, err)
	}
	cancel()
	close(remote.holdWrite)
	select {
	case outcome := <-outcomes:
		if outcome != "filled" {
			t.Fatalf("shadow outcome = %q, want filled after the caller left", outcome)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no shadow verdict")
	}
}
