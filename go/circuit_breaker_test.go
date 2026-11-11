package dialcache_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	dialcache "github.com/lan17/DialCache/go"
)

// scriptedRemote fails, succeeds or blocks on demand and counts the calls that
// reach it.
type scriptedRemote struct {
	readErr, writeErr, invalidateErr func() error
	readBlock                        chan struct{} // when set, Read waits for it to close
	reads, writes, invalidates       atomic.Int64
}

func (r *scriptedRemote) Read(context.Context, string, string) (dialcache.ReadResult, error) {
	r.reads.Add(1)
	if r.readBlock != nil {
		<-r.readBlock
	}
	if r.readErr != nil {
		if err := r.readErr(); err != nil {
			return dialcache.ReadResult{}, err
		}
	}
	return dialcache.ReadResult{Kind: "miss", Reason: "value_absent"}, nil
}

func (r *scriptedRemote) Write(context.Context, string, dialcache.Frame, time.Duration) error {
	r.writes.Add(1)
	if r.writeErr != nil {
		return r.writeErr()
	}
	return nil
}

func (r *scriptedRemote) Invalidate(context.Context, string, int64, int64) error {
	r.invalidates.Add(1)
	if r.invalidateErr != nil {
		return r.invalidateErr()
	}
	return nil
}

var errRemoteDown = errors.New("remote down")

func always(err error) func() error { return func() error { return err } }

func newBreaker(t *testing.T, remote dialcache.Remote, options dialcache.CircuitBreakerOptions) dialcache.Remote {
	t.Helper()
	breaker, err := dialcache.NewCircuitBreaker(remote, options)
	if err != nil {
		t.Fatal(err)
	}
	return breaker
}

func read(breaker dialcache.Remote) error {
	_, err := breaker.Read(context.Background(), "value", "")
	return err
}

func write(ctx context.Context, breaker dialcache.Remote) error {
	return breaker.Write(ctx, "value", dialcache.Frame{}, time.Minute)
}

func TestCircuitBreakerOpensOnlyAtHalfOfTheLastHundredCalls(t *testing.T) {
	remote := &scriptedRemote{readErr: always(errRemoteDown)}
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{})
	for range 99 {
		if err := read(breaker); !errors.Is(err, errRemoteDown) {
			t.Fatalf("read before 100 calls = %v, want the remote error", err)
		}
	}
	// Ninety-nine consecutive failures are not enough on their own.
	if err := read(breaker); !errors.Is(err, errRemoteDown) {
		t.Fatalf("100th read = %v, want the remote error", err)
	}
	if err := read(breaker); !errors.Is(err, dialcache.ErrCircuitOpen) {
		t.Fatalf("read after 100 failures = %v, want ErrCircuitOpen", err)
	}
	if got := remote.reads.Load(); got != 100 {
		t.Fatalf("remote reads = %d, want 100", got)
	}

	var calls int64
	remote = &scriptedRemote{readErr: func() error {
		calls++
		if calls%2 == 0 && calls%100 != 0 { // 49 failures in every 100 calls
			return errRemoteDown
		}
		return nil
	}}
	breaker = newBreaker(t, remote, dialcache.CircuitBreakerOptions{})
	for range 1000 {
		if errors.Is(read(breaker), dialcache.ErrCircuitOpen) {
			t.Fatal("a 49% failure rate opened the circuit")
		}
	}
}

func TestCircuitBreakerKeepsReadsAndWritesApart(t *testing.T) {
	remote := &scriptedRemote{writeErr: always(errRemoteDown)}
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{})
	for range 100 {
		_ = write(context.Background(), breaker)
	}
	if err := write(context.Background(), breaker); !errors.Is(err, dialcache.ErrCircuitOpen) {
		t.Fatalf("write after 100 failures = %v, want ErrCircuitOpen", err)
	}
	for range 200 {
		if err := read(breaker); err != nil {
			t.Fatalf("read with only the write circuit open = %v", err)
		}
	}
	if remote.reads.Load() != 200 || remote.writes.Load() != 100 {
		t.Fatalf("remote reads=%d writes=%d, want 200 and 100", remote.reads.Load(), remote.writes.Load())
	}
}

func TestCircuitBreakerIgnoresAnsweredErrorsAndAbandonedWrites(t *testing.T) {
	remote := &scriptedRemote{
		readErr:  always(&dialcache.RedisPayloadError{Message: "bad frame"}),
		writeErr: always(context.Canceled),
	}
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for range 200 {
		_ = read(breaker)
		_ = write(cancelled, breaker)
	}
	if remote.reads.Load() != 200 || remote.writes.Load() != 200 {
		t.Fatalf("remote reads=%d writes=%d, want 200 each: neither circuit may open", remote.reads.Load(), remote.writes.Load())
	}
}

func TestCircuitBreakerProbesOnceAfterOpenFor(t *testing.T) {
	var mu sync.Mutex
	var transitions []string
	remote := &scriptedRemote{readErr: always(errRemoteDown)}
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{
		OpenFor: 20 * time.Millisecond,
		OnStateChange: func(operation string, from, to dialcache.CircuitState) {
			mu.Lock()
			transitions = append(transitions, operation+" "+from.String()+">"+to.String())
			mu.Unlock()
		},
	})
	for range 100 {
		_ = read(breaker)
	}
	time.Sleep(30 * time.Millisecond)
	if err := read(breaker); !errors.Is(err, errRemoteDown) {
		t.Fatalf("probe = %v, want the remote error", err)
	}
	if err := read(breaker); !errors.Is(err, dialcache.ErrCircuitOpen) {
		t.Fatalf("read after a failed probe = %v, want ErrCircuitOpen", err)
	}

	time.Sleep(30 * time.Millisecond)
	remote.readErr = nil
	remote.readBlock = make(chan struct{})
	probe := make(chan error)
	go func() { probe <- read(breaker) }()
	for remote.reads.Load() != 102 {
		time.Sleep(time.Millisecond)
	}
	if err := read(breaker); !errors.Is(err, dialcache.ErrCircuitOpen) {
		t.Fatalf("read during the probe = %v, want ErrCircuitOpen", err)
	}
	close(remote.readBlock)
	if err := <-probe; err != nil {
		t.Fatalf("successful probe = %v", err)
	}
	if err := read(breaker); err != nil {
		t.Fatalf("read after a successful probe = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	want := []string{
		"read closed>open", "read open>half-open", "read half-open>open",
		"read open>half-open", "read half-open>closed",
	}
	if len(transitions) != len(want) {
		t.Fatalf("transitions = %v, want %v", transitions, want)
	}
	for i := range want {
		if transitions[i] != want[i] {
			t.Fatalf("transitions = %v, want %v", transitions, want)
		}
	}
}

// A read the cache abandons at its deadline counts as failed at that moment,
// even though the dispatched command never returns.
func TestCircuitBreakerCountsAReadAtItsDeadline(t *testing.T) {
	remote := &scriptedRemote{readBlock: make(chan struct{})}
	defer close(remote.readBlock)
	opened := make(chan struct{})
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{
		OnStateChange: func(_ string, _, to dialcache.CircuitState) {
			if to == dialcache.CircuitOpen {
				close(opened)
			}
		},
	})
	cache, err := dialcache.New(dialcache.WithRemote(breaker), dialcache.WithLocalCapacity(0), dialcache.WithRemoteReadTimeout(time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	ctx, done := cache.Enable(context.Background())
	defer done()
	load := func(id string) (string, time.Duration) {
		start := time.Now()
		value, err := dialcache.GetOrLoad(ctx, cache, dialcache.Operation[string]{
			Identity: dialcache.Identity{KeyType: "user", UseCase: "breaker", ID: id},
			Policy:   dialcache.Policy{RemoteTTL: time.Minute},
		}, func(context.Context) (string, error) { return "source " + id, nil })
		if err != nil {
			t.Fatal(err)
		}
		return value, time.Since(start)
	}
	for i := range 100 {
		load(string(rune('A' + i)))
	}
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("the read circuit did not open while the abandoned reads were still running")
	}
	value, took := load("after")
	if value != "source after" || remote.reads.Load() != 100 {
		t.Fatalf("value=%q reads=%d, want the source value without a remote read", value, remote.reads.Load())
	}
	if took > time.Second {
		t.Fatalf("call with an open circuit took %v", took)
	}
}

func TestCircuitBreakerNeverGatesInvalidate(t *testing.T) {
	invalidation := errors.New("invalidation failed")
	remote := &scriptedRemote{readErr: always(errRemoteDown), writeErr: always(errRemoteDown), invalidateErr: always(invalidation)}
	breaker := newBreaker(t, remote, dialcache.CircuitBreakerOptions{})
	for range 100 {
		_ = read(breaker)
		_ = write(context.Background(), breaker)
	}
	cache, err := dialcache.New(dialcache.WithRemote(breaker))
	if err != nil {
		t.Fatal(err)
	}
	err = cache.Invalidate(context.Background(), dialcache.Identity{KeyType: "user", ID: "42"}, 0)
	if !errors.Is(err, invalidation) || remote.invalidates.Load() != 1 {
		t.Fatalf("Invalidate = %v after %d remote calls, want the remote error after 1", err, remote.invalidates.Load())
	}
}

func TestNewCircuitBreakerRejectsInvalidOptions(t *testing.T) {
	if _, err := dialcache.NewCircuitBreaker(nil, dialcache.CircuitBreakerOptions{}); !errors.Is(err, dialcache.ErrInvalidOption) {
		t.Fatalf("nil remote: %v", err)
	}
	if _, err := dialcache.NewCircuitBreaker(&scriptedRemote{}, dialcache.CircuitBreakerOptions{OpenFor: -time.Second}); !errors.Is(err, dialcache.ErrInvalidOption) {
		t.Fatalf("negative OpenFor: %v", err)
	}
}
