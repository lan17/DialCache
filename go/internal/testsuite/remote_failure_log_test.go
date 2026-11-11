package dialcache_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/lan17/DialCache/go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

type failureLog struct {
	mu       sync.Mutex
	messages []string
	details  []any
}

func (l *failureLog) record(message string, details any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.messages, l.details = append(l.messages, message), append(l.details, details)
}
func (l *failureLog) Debug(message string, details any) { l.record(message, details) }
func (l *failureLog) Warn(message string, details any)  { l.record(message, details) }
func (l *failureLog) Error(message string, details any) { l.record(message, details) }

// failingRemote fails every operation with err.
type failingRemote struct{ err error }

func (r failingRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{}, r.err
}
func (r failingRemote) Write(context.Context, string, Frame, time.Duration) error { return r.err }
func (r failingRemote) Invalidate(context.Context, string, int64, int64) error    { return r.err }

// missingRemote misses every read, so each call refills through the wrapped
// remote's write.
type missingRemote struct{ Remote }

func (missingRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
}

// blockingRemote never answers, so deadlines end its calls.
type blockingRemote struct{}

func (blockingRemote) Read(ctx context.Context, _, _ string) (ReadResult, error) {
	<-ctx.Done()
	return ReadResult{}, ctx.Err()
}
func (blockingRemote) Write(ctx context.Context, _ string, _ Frame, _ time.Duration) error {
	<-ctx.Done()
	return ctx.Err()
}
func (blockingRemote) Invalidate(ctx context.Context, _ string, _, _ int64) error {
	<-ctx.Done()
	return ctx.Err()
}

// panickingRemote panics in every operation, as a faulty adapter would.
type panickingRemote struct{}

func (panickingRemote) Read(context.Context, string, string) (ReadResult, error) {
	panic("adapter bug")
}
func (panickingRemote) Write(context.Context, string, Frame, time.Duration) error {
	panic("adapter bug")
}
func (panickingRemote) Invalidate(context.Context, string, int64, int64) error {
	panic("adapter bug")
}

// corruptFrameRemote holds a frame whose encoding byte is invalid, which the
// protocol reports as a payload error rather than a miss.
type corruptFrameRemote struct{}

func (corruptFrameRemote) Read(context.Context, string, string) (ReadResult, error) {
	raw, _ := EncodeFrame(Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: []byte(`"cached"`)})
	raw[9] = 2
	result := DecodeFrame(raw, true, nil)
	return result, result.Error()
}
func (corruptFrameRemote) Write(context.Context, string, Frame, time.Duration) error { return nil }
func (corruptFrameRemote) Invalidate(context.Context, string, int64, int64) error    { return nil }

// replyError is a Redis error reply as go-redis reports it.
type replyError string

func (e replyError) Error() string { return string(e) }
func (replyError) RedisError()     {}

// steppedClock moves elapsed time forward on request; wall time stays real.
type steppedClock struct {
	origin time.Time
	step   atomic.Int64
}

func (c *steppedClock) WallMS() int64    { return time.Now().UnixMilli() }
func (c *steppedClock) ElapsedMS() int64 { return time.Since(c.origin).Milliseconds() + c.step.Load() }

func unreachableRedis(t *testing.T) redis.UniversalClient {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	client := redis.NewClient(&redis.Options{Addr: address, MaxRetries: -1, DialerRetries: 1, DialerRetryTimeout: time.Millisecond})
	t.Cleanup(func() { client.Close() })
	return client
}

// droppingRedis accepts each connection and closes it at once, as a Redis
// restart does to established connections.
func droppingRedis(t *testing.T) redis.UniversalClient {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	client := redis.NewClient(&redis.Options{Addr: listener.Addr().String(), MaxRetries: -1, DialerRetries: 1, DialerRetryTimeout: time.Millisecond})
	t.Cleanup(func() { client.Close() })
	return client
}

type failureRun struct {
	cache    *Cache
	identity Identity
	log      *failureLog
	mu       sync.Mutex
	errors   map[any]int
}

var failureIdentity = Identity{Namespace: "test", KeyType: "entity", ID: "1", UseCase: "read", Tracked: true}

func newFailureRun(remote Remote, options ...Option) *failureRun {
	run := &failureRun{identity: failureIdentity, log: &failureLog{}, errors: map[any]int{}}
	options = append([]Option{WithRemote(remote), WithLogger(run.log), WithRemoteReadTimeout(time.Second), WithObserver(func(event Event) {
		if event.Kind == "error" {
			run.mu.Lock()
			run.errors[event.Data["error"]]++
			run.mu.Unlock()
		}
	})}, options...)
	run.cache = MustNew(options...)
	return run
}

func (run *failureRun) read(t *testing.T, calls int) {
	t.Helper()
	operation := Operation[string]{Identity: run.identity, Policy: Policy{RemoteTTL: time.Minute}}
	for range calls {
		ctx, done := run.cache.Enable(context.Background())
		value, err := GetOrLoad(ctx, run.cache, operation, func(context.Context) (string, error) { return "source", nil })
		done()
		if value != "source" || err != nil {
			t.Fatalf("remote failure changed the source result: %q %v", value, err)
		}
	}
}

func (run *failureRun) invalidate(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := run.cache.Invalidate(ctx, run.identity, 0); err == nil {
		t.Fatal("invalidation failure was not surfaced")
	}
}

func TestRoutineRemoteFailuresAreMetricOnly(t *testing.T) {
	down := NewRedisAdapter(unreachableRedis(t))
	for name, test := range map[string]struct {
		remote  Remote
		options []Option
		failure string
	}{
		"redis down":          {remote: down, failure: "cache_read"},
		"redis down on write": {remote: missingRemote{down}, failure: "cache_write"},
		"read deadline":       {remote: blockingRemote{}, options: []Option{WithRemoteReadTimeout(10 * time.Millisecond)}, failure: "cache_read_timeout"},
		"failover reply":      {remote: failingRemote{replyError("LOADING Redis is loading the dataset in memory")}, failure: "cache_read"},
		"read-only replica":   {remote: failingRemote{replyError("READONLY You can't write against a read only replica.")}, failure: "cache_read"},
		"connection limit":    {remote: failingRemote{replyError("ERR max number of clients reached")}, failure: "cache_read"},
		"connection dropped":  {remote: NewRedisAdapter(droppingRedis(t)), failure: "cache_read"},
	} {
		t.Run(name, func(t *testing.T) {
			run := newFailureRun(test.remote, test.options...)
			run.read(t, 20)
			run.invalidate(t)
			if len(run.log.messages) != 0 {
				t.Fatalf("routine failure logged: %v %v", run.log.messages, run.log.details)
			}
			if run.errors[test.failure] != 20 || run.errors["invalidation"] != 1 {
				t.Fatalf("error events = %v; want 20 %s and 1 invalidation", run.errors, test.failure)
			}
		})
	}
}

func TestUnusualRemoteFailuresStayLogged(t *testing.T) {
	for name, remote := range map[string]Remote{
		"denied command": failingRemote{replyError("NOPERM User has no permissions to run the 'mget' command")},
		"script error":   failingRemote{replyError("ERR Error running script")},
		"protocol reply": failingRemote{&RedisProtocolError{Message: "invalid Redis invalidation reply; expected integer 1"}},
		"adapter panic":  panickingRemote{},
		"unknown error":  failingRemote{errors.New("circuit breaker is open")},
		"varying text":   &countingRemote{},
	} {
		t.Run(name, func(t *testing.T) {
			run := newFailureRun(remote)
			run.read(t, 5)
			run.invalidate(t)
			want := []string{"Error getting value from Redis cache", "Error writing DialCache invalidation watermark"}
			if len(run.log.messages) != len(want) || run.log.messages[0] != want[0] || run.log.messages[1] != want[1] {
				t.Fatalf("logs = %v; want %v", run.log.messages, want)
			}
			if run.errors["cache_read"] != 5 || run.errors["invalidation"] != 1 {
				t.Fatalf("error events = %v", run.errors)
			}
		})
	}
}

// Without an observer nothing records the error events, so a routine failure
// still logs, at the same bounded rate.
func TestRoutineFailureLogsWithoutObserver(t *testing.T) {
	var log failureLog
	cache := MustNew(WithRemote(NewRedisAdapter(unreachableRedis(t))), WithLogger(&log))
	operation := Operation[string]{Identity: failureIdentity, Policy: Policy{RemoteTTL: time.Minute}}
	for range 20 {
		ctx, done := cache.Enable(context.Background())
		value, err := GetOrLoad(ctx, cache, operation, func(context.Context) (string, error) { return "source", nil })
		done()
		if value != "source" || err != nil {
			t.Fatalf("remote failure changed the source result: %q %v", value, err)
		}
	}
	if len(log.messages) != 1 || log.messages[0] != "Error getting value from Redis cache" {
		t.Fatalf("logs = %v; want one read warning", log.messages)
	}
}

// countingRemote fails with a new message each call, all of one type.
type countingRemote struct{ calls atomic.Int64 }

func (r *countingRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{}, fmt.Errorf("decode failed at byte %d", r.calls.Add(1))
}
func (r *countingRemote) Write(context.Context, string, Frame, time.Duration) error {
	return fmt.Errorf("write failed at byte %d", r.calls.Add(1))
}
func (r *countingRemote) Invalidate(context.Context, string, int64, int64) error {
	return fmt.Errorf("invalidate failed at byte %d", r.calls.Add(1))
}

// switchingRemote fails reads with whatever failure the test sets.
type switchingRemote struct {
	corruptFrameRemote
	err error
}

func (r *switchingRemote) Read(ctx context.Context, valueKey, watermarkKey string) (ReadResult, error) {
	if r.err != nil {
		return ReadResult{}, r.err
	}
	return r.corruptFrameRemote.Read(ctx, valueKey, watermarkKey)
}

// A new kind of unusual failure logs even while an earlier one is throttled.
func TestDistinctUnusualFailuresLogSeparately(t *testing.T) {
	remote := &switchingRemote{}
	run := newFailureRun(remote)
	run.read(t, 2)
	remote.err = replyError("NOPERM User has no permissions to run the 'mget' command")
	run.read(t, 2)
	remote.err = nil
	run.read(t, 1)
	if len(run.log.messages) != 2 || !strings.HasPrefix(fmt.Sprint(run.log.details[1]), "NOPERM") {
		t.Fatalf("logs = %v %v; want the corrupt frame and the NOPERM reply", run.log.messages, run.log.details)
	}
	if run.errors["cache_read"] != 5 {
		t.Fatalf("error events = %v; want 5 cache_read", run.errors)
	}
}

// A corrupt hot key fails every read until its TTL ends, because a failed read
// never refills, so its warning repeats at most once a minute.
func TestCorruptFrameLogsOncePerMinute(t *testing.T) {
	clock := &steppedClock{origin: time.Now()}
	run := newFailureRun(corruptFrameRemote{}, WithClock(clock))
	run.read(t, 10)
	var payload *RedisPayloadError
	if len(run.log.messages) != 1 || run.log.messages[0] != "Error getting value from Redis cache" || !errors.As(run.log.details[0].(error), &payload) {
		t.Fatalf("logs = %v %v; want one corrupt frame warning", run.log.messages, run.log.details)
	}
	if run.errors["cache_read"] != 10 {
		t.Fatalf("error events = %v; want 10 cache_read", run.errors)
	}
	clock.step.Add(time.Minute.Milliseconds() - 100)
	run.read(t, 1)
	if len(run.log.messages) != 1 {
		t.Fatalf("logged again within a minute: %v", run.log.messages)
	}
	clock.step.Add(100)
	run.read(t, 1)
	if len(run.log.messages) != 2 || run.errors["cache_read"] != 12 {
		t.Fatalf("logs = %v, error events = %v; want a second warning after a minute", run.log.messages, run.errors)
	}
}

// The outage reaches an exporter as error counts, with no warning.
func TestRedisOutageIsCountedByPrometheus(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics, err := NewPrometheusMetrics(registry, "")
	if err != nil {
		t.Fatal(err)
	}
	run := newFailureRun(NewRedisAdapter(unreachableRedis(t)), WithMetrics(metrics))
	run.read(t, 20)
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	count := 0.0
	for _, family := range families {
		if family.GetName() != "dialcache_error_counter" {
			continue
		}
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if label.GetName() == "error" && label.GetValue() == "cache_read" {
					count += metric.Counter.GetValue()
				}
			}
		}
	}
	if count != 20 || len(run.log.messages) != 0 {
		t.Fatalf("cache_read errors = %v, logs = %v; want 20 and none", count, run.log.messages)
	}
}

// A dark shadow fill that cannot reach Redis reports fill_error and its
// cache_write event, with no warning.
func TestShadowFillOutageIsMetricOnly(t *testing.T) {
	outcomes := make(chan Event, 1)
	run := newFailureRun(missingRemote{NewRedisAdapter(unreachableRedis(t))}, WithShadowOutcomes(func(event Event) { outcomes <- event }))
	zero, full := float64(0), float64(100)
	operation := Operation[string]{Identity: failureIdentity, Policy: Policy{RemoteTTL: time.Minute, RemoteRamp: &zero, Shadow: &ShadowPolicy{Ramp: &full}}}
	ctx, done := run.cache.Enable(context.Background())
	value, err := GetOrLoad(ctx, run.cache, operation, func(context.Context) (string, error) { return "source", nil })
	done()
	if value != "source" || err != nil {
		t.Fatalf("shadow failure changed the source result: %q %v", value, err)
	}
	select {
	case event := <-outcomes:
		if event.Outcome != "fill_error" {
			t.Fatalf("outcome = %q; want fill_error", event.Outcome)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing shadow outcome")
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.errors["cache_write"] != 1 || len(run.log.messages) != 0 {
		t.Fatalf("error events = %v, logs = %v; want one cache_write and no warning", run.errors, run.log.messages)
	}
}

// codeRemote fails each read with a Redis reply whose error code is new.
type codeRemote struct{ calls atomic.Int64 }

func (r *codeRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{}, replyError(fmt.Sprintf("CODE%d unexpected", r.calls.Add(1)))
}
func (*codeRemote) Write(context.Context, string, Frame, time.Duration) error { return nil }
func (*codeRemote) Invalidate(context.Context, string, int64, int64) error    { return nil }

// Ever-new error codes cannot make every call log.
func TestNewErrorCodesStayBounded(t *testing.T) {
	run := newFailureRun(&codeRemote{})
	run.read(t, 200)
	logged := len(run.log.messages)
	run.read(t, 100)
	if logged >= 200 || len(run.log.messages) != logged || run.errors["cache_read"] != 300 {
		t.Fatalf("warnings = %d then %d, error events = %v; want a bounded count", logged, len(run.log.messages), run.errors)
	}
}
