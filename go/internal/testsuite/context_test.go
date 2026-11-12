package dialcache_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
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
}

func TestContextServedShadowOutlivesCaller(t *testing.T) {
	// Without coalescing the shadow job starts from the caller's own context.
	for _, coalesce := range []bool{true, false} {
		outcomes := make(chan string, 4)
		cache := MustNew(WithRemote(newContextRemote()), WithShadowOutcomes(func(e Event) { outcomes <- e.Outcome }))
		op := contextOperation("served-shadow", Policy{RemoteTTL: time.Minute, Coalesce: Ptr(coalesce), Shadow: &ShadowPolicy{Ramp: Ptr(100.0)}})
		ctx, done := cache.Enable(context.Background())
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
			t.Fatalf("coalesce=%v: hit = (%q, %v)", coalesce, v, err)
		}
		cancel()
		close(returned)
		select {
		case outcome := <-outcomes:
			if outcome != "match" {
				t.Fatalf("coalesce=%v: shadow outcome = %q, want match after the caller left", coalesce, outcome)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("coalesce=%v: no shadow verdict", coalesce)
		}
		done()
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

func TestContextAbandonedCoalescedDarkShadowDoesNotFill(t *testing.T) {
	remote := newContextRemote()
	outcomes := make(chan string, 4)
	cache := MustNew(WithRemote(remote), WithShadowOutcomes(func(e Event) { outcomes <- e.Outcome }))
	// The local layer makes the dark call coalesce, so the source is shared work.
	op := contextOperation("dark-shadow-abandoned", Policy{LocalTTL: time.Minute, RemoteTTL: time.Minute, RemoteRamp: Ptr(0.0), Shadow: &ShadowPolicy{Ramp: Ptr(100.0)}})
	ctx, done := cache.Enable(context.Background())
	defer done()
	release := make(chan struct{})
	callerCtx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	// The source ignores its context and returns only after its caller left.
	if _, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (string, error) { <-release; return "old", nil }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("dark call error = %v, want its own deadline", err)
	}
	close(release)
	select {
	case outcome := <-outcomes:
		if outcome == "filled" {
			t.Fatal("shared shadow work filled Redis after every caller left")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no shadow verdict")
	}
	remote.mu.Lock()
	defer remote.mu.Unlock()
	if len(remote.values) != 0 {
		t.Fatalf("Redis values after abandoned shadow work = %d, want 0", len(remote.values))
	}
}

func TestContextRequestLocalLeaderLeavesWhileOtherScopesWait(t *testing.T) {
	cache := MustNew(WithRemote(newContextRemote()))
	op := contextOperation("request-local", Policy{RemoteTTL: time.Minute, RequestLocal: true})
	release := make(chan struct{})
	sourceErr := make(chan error, 1)
	load := func(ctx context.Context) (string, error) {
		<-release
		sourceErr <- ctx.Err()
		return "value", nil
	}

	scopeA, closeA := cache.Enable(context.Background())
	leaderCtx, cancelLeader := context.WithCancel(scopeA)
	leader := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(leaderCtx, cache, op, load); leader <- contextResult{v, err} }()
	for cache.GetCoalescingState().Process.ActiveLeaders != 1 {
		time.Sleep(time.Millisecond)
	}

	scopeB, closeB := cache.Enable(context.Background())
	defer closeB()
	follower := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(scopeB, cache, op, load); follower <- contextResult{v, err} }()
	waitForFollowers(t, cache, 1)
	// A second caller in scope B joins that scope's request flight and leaves at its own deadline.
	shortCtx, cancelShort := context.WithTimeout(scopeB, 50*time.Millisecond)
	defer cancelShort()
	short := make(chan contextResult, 1)
	go func() { v, err := GetOrLoad(shortCtx, cache, op, load); short <- contextResult{v, err} }()
	if r := receive(t, short); !errors.Is(r.err, context.DeadlineExceeded) {
		t.Fatalf("request-local follower = %+v, want its own deadline", r)
	}

	cancelLeader()
	closeA()
	if r := receive(t, leader); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("leader = %+v, want its own cancellation", r)
	}
	close(release)
	if err := <-sourceErr; err != nil {
		t.Fatalf("the departed leader's cancellation reached the shared source: %v", err)
	}
	if r := receive(t, follower); r.value != "value" || r.err != nil {
		t.Fatalf("scope B = %+v, want the shared value", r)
	}
	deadline := time.Now().Add(2 * time.Second)
	for cache.GetCoalescingState().Process.ActiveLeaders != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the shared flight was not cleared")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestContextCallerThatLeftIsNotAProviderOrSourceFailure(t *testing.T) {
	var mu sync.Mutex
	var failures []string
	observe := func(e Event) {
		if e.Kind == "error" || e.Kind == "disabled" {
			detail := e.Data["error"]
			if detail == nil {
				detail = e.Data["reason"]
			}
			mu.Lock()
			failures = append(failures, fmt.Sprintf("%s:%v:%v", e.Kind, e.Data["layer"], detail))
			mu.Unlock()
		}
	}
	recorded := func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), failures...) }

	t.Run("provider", func(t *testing.T) {
		failures = nil
		cache := MustNew(WithRemote(newContextRemote()), WithObserver(observe),
			WithPolicyProvider(func(ctx context.Context, _ Identity) (RuntimePolicy, error) { return nil, ctx.Err() }))
		op := contextOperation("left-before-provider", Policy{RemoteTTL: time.Minute, Coalesce: Ptr(false)})
		ctx, done := cache.Enable(context.Background())
		defer done()
		callerCtx, cancel := context.WithCancel(ctx)
		cancel()
		var loads atomic.Int32
		v, err := GetOrLoad(callerCtx, cache, op, func(context.Context) (string, error) { loads.Add(1); return "value", nil })
		if v != "" || !errors.Is(err, context.Canceled) || loads.Load() != 0 {
			t.Fatalf("GetOrLoad = (%q, %v) with %d loads, want the caller's own error and no load", v, err, loads.Load())
		}
		if got := recorded(); len(got) != 0 {
			t.Fatalf("recorded %v for a caller that left", got)
		}
	})
	t.Run("source", func(t *testing.T) {
		failures = nil
		cache := MustNew(WithRemote(newContextRemote()), WithObserver(observe))
		op := contextOperation("left-during-source", Policy{RemoteTTL: time.Minute, Coalesce: Ptr(false)})
		ctx, done := cache.Enable(context.Background())
		defer done()
		callerCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		entered := make(chan struct{})
		results := make(chan contextResult, 1)
		go func() {
			v, err := GetOrLoad(callerCtx, cache, op, func(c context.Context) (string, error) { close(entered); <-c.Done(); return "", c.Err() })
			results <- contextResult{v, err}
		}()
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("loader did not start")
		}
		cancel()
		if r := receive(t, results); !errors.Is(r.err, context.Canceled) {
			t.Fatalf("caller = %+v, want its own cancellation", r)
		}
		for _, f := range recorded() {
			if strings.Contains(f, "fallback") {
				t.Fatalf("recorded %q for a caller that left", f)
			}
		}
		// A real source failure from a live caller is still recorded.
		if _, err := GetOrLoad(ctx, cache, op, func(context.Context) (string, error) { return "", errors.New("down") }); err == nil {
			t.Fatal("source error was lost")
		}
		if got := recorded(); !slices.Contains(got, "error:remote:fallback") {
			t.Fatalf("recorded %v, want the live caller's fallback error", got)
		}
	})
}
