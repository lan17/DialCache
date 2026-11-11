package dialcache

import (
	"context"
	"errors"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type invalidationCall struct {
	keys          []string
	now, bufferMS int64
}

type scalarInvalidator struct {
	calls []invalidationCall
	fail  map[string]error
}

func (r *scalarInvalidator) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{}, errors.New("unexpected read")
}
func (r *scalarInvalidator) Write(context.Context, string, Frame, time.Duration) error {
	return errors.New("unexpected write")
}
func (r *scalarInvalidator) Invalidate(_ context.Context, key string, now, bufferMS int64) error {
	r.calls = append(r.calls, invalidationCall{[]string{key}, now, bufferMS})
	return r.fail[key]
}

type batchInvalidator struct {
	scalarInvalidator
	batches []invalidationCall
}

func (r *batchInvalidator) InvalidateMany(_ context.Context, keys []string, now, bufferMS int64) error {
	r.batches = append(r.batches, invalidationCall{append([]string{}, keys...), now, bufferMS})
	return nil
}

type recordedEvents struct{ invalidations, errors []map[string]any }

func (e *recordedEvents) observe(event Event) {
	switch event.Kind {
	case "invalidation":
		e.invalidations = append(e.invalidations, event.Data)
	case "error":
		e.errors = append(e.errors, event.Data)
	}
}

func TestInvalidateMany(t *testing.T) {
	const wall = int64(1700000000000)
	identities := []Identity{
		{KeyType: "repl", ID: "a"},
		{Namespace: "other", KeyType: "repl", ID: "a"},
		{KeyType: "repl", ID: "b", UseCase: "read", Args: [][2]string{{"x", "1"}}},
		{KeyType: "repl", ID: "a", UseCase: "another"},
		{KeyType: "org", ID: "c"},
	}
	keys := []string{"{app:repl:a}#watermark", "{other:repl:a}#watermark", "{app:repl:b}#watermark", "{app:org:c}#watermark"}
	newCache := func(remote Remote, events *recordedEvents, logger *boundaryLogger) *Cache {
		clock := &boundaryClock{}
		clock.wall.Store(wall)
		options := []Option{WithNamespace("app"), WithClock(clock), WithObserver(events.observe), WithLogger(logger)}
		if remote != nil {
			options = append(options, WithRemote(remote))
		}
		return MustNew(options...)
	}

	t.Run("scalar fallback dispatches each entity once with one timestamp", func(t *testing.T) {
		remote, events := &scalarInvalidator{}, &recordedEvents{}
		if err := newCache(remote, events, &boundaryLogger{}).InvalidateMany(context.Background(), identities, 250*time.Millisecond); err != nil {
			t.Fatal(err)
		}
		var want []invalidationCall
		for _, key := range keys {
			want = append(want, invalidationCall{[]string{key}, wall, 250})
		}
		if !reflect.DeepEqual(remote.calls, want) {
			t.Fatalf("calls %#v, want %#v", remote.calls, want)
		}
		if len(events.invalidations) != len(keys) || events.invalidations[1]["cacheNamespace"] != "other" || events.invalidations[3]["keyType"] != "org" || len(events.errors) != 0 {
			t.Fatalf("events %#v", events)
		}
	})

	t.Run("batch remote receives the deduplicated keys in one call", func(t *testing.T) {
		remote := &batchInvalidator{}
		if err := newCache(remote, &recordedEvents{}, &boundaryLogger{}).InvalidateMany(context.Background(), identities, 0); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(remote.batches, []invalidationCall{{keys, wall, 0}}) || len(remote.calls) != 0 {
			t.Fatalf("batches %#v, scalar calls %#v", remote.batches, remote.calls)
		}
	})

	t.Run("an invalid identity dispatches nothing", func(t *testing.T) {
		remote, events, logger := &batchInvalidator{}, &recordedEvents{}, &boundaryLogger{}
		err := newCache(remote, events, logger).InvalidateMany(context.Background(), append(identities, Identity{KeyType: "repl", ID: "{x}"}), 0)
		if err == nil || len(remote.batches) != 0 || len(remote.calls) != 0 {
			t.Fatalf("err %v, batches %#v, calls %#v", err, remote.batches, remote.calls)
		}
		if logger.warnings.Load() != 1 || len(events.invalidations) != 0 || len(events.errors) != 0 {
			t.Fatalf("warnings %d, events %#v", logger.warnings.Load(), events)
		}
	})

	t.Run("an invalid buffer is rejected before anything else", func(t *testing.T) {
		remote, events, logger := &batchInvalidator{}, &recordedEvents{}, &boundaryLogger{}
		for _, buffer := range []time.Duration{-time.Millisecond, time.Microsecond, MaxSupportedDuration + time.Millisecond} {
			if err := newCache(remote, events, logger).InvalidateMany(context.Background(), identities, buffer); !errors.Is(err, ErrInvalidOperation) {
				t.Fatalf("buffer %s: %v", buffer, err)
			}
		}
		if len(remote.batches) != 0 || logger.warnings.Load() != 0 || len(events.invalidations) != 0 {
			t.Fatal("invalid buffer reached dispatch or telemetry")
		}
	})

	t.Run("a failure stops the scalar fallback and reports each entity type", func(t *testing.T) {
		problem := errors.New("redis down")
		remote := &scalarInvalidator{fail: map[string]error{keys[1]: problem}}
		events, logger := &recordedEvents{}, &boundaryLogger{}
		if err := newCache(remote, events, logger).InvalidateMany(context.Background(), identities, 0); err != problem {
			t.Fatalf("err %v", err)
		}
		if len(remote.calls) != 2 || logger.warnings.Load() != 1 {
			t.Fatalf("calls %#v, warnings %d", remote.calls, logger.warnings.Load())
		}
		var types [][2]any
		for _, data := range events.errors {
			types = append(types, [2]any{data["cacheNamespace"], data["keyType"]})
			if data["error"] != "invalidation" || data["useCase"] != "watermark" {
				t.Fatalf("error event %#v", data)
			}
		}
		if !reflect.DeepEqual(types, [][2]any{{"app", "repl"}, {"other", "repl"}, {"app", "org"}}) {
			t.Fatalf("error events %#v", types)
		}
	})

	t.Run("a remote is required", func(t *testing.T) {
		events := &recordedEvents{}
		if err := newCache(nil, events, &boundaryLogger{}).InvalidateMany(context.Background(), identities[:1], 0); err != ErrNoRemote {
			t.Fatalf("err %v", err)
		}
		if len(events.invalidations) != 1 || len(events.errors) != 1 {
			t.Fatalf("events %#v", events)
		}
	})

	t.Run("an empty batch dispatches nothing", func(t *testing.T) {
		remote := &batchInvalidator{}
		if err := newCache(remote, &recordedEvents{}, &boundaryLogger{}).InvalidateMany(context.Background(), nil, 0); err != nil || len(remote.batches) != 0 {
			t.Fatalf("err %v, batches %#v", err, remote.batches)
		}
	})
}

type pipelineHook struct {
	pipelines *[][]redis.Cmder
	run       func(redis.Cmder) error
}

func (h pipelineHook) DialHook(redis.DialHook) redis.DialHook {
	return func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("unexpected network access")
	}
}
func (h pipelineHook) ProcessHook(redis.ProcessHook) redis.ProcessHook {
	return func(context.Context, redis.Cmder) error { return errors.New("unexpected single command") }
}
func (h pipelineHook) ProcessPipelineHook(redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(_ context.Context, cmds []redis.Cmder) error {
		*h.pipelines = append(*h.pipelines, cmds)
		for _, cmd := range cmds {
			if err := h.run(cmd); err != nil {
				cmd.SetErr(err)
			}
		}
		return nil
	}
}

func TestRedisAdapterInvalidateMany(t *testing.T) {
	keys := []string{"{a}#watermark", "{b}#watermark", "{c}#watermark"}
	pipelined := func(run func(redis.Cmder) error) (*RedisAdapter, *[][]redis.Cmder) {
		var pipelines [][]redis.Cmder
		client := redis.NewClient(&redis.Options{Addr: "unused", MaxRetries: -1})
		client.AddHook(pipelineHook{&pipelines, run})
		t.Cleanup(func() { _ = client.Close() })
		return NewRedisAdapter(client), &pipelines
	}
	ok := func(cmd redis.Cmder) error {
		cmd.(*redis.Cmd).SetVal(int64(1))
		return nil
	}
	shape := func(pipelines [][]redis.Cmder) [][]string {
		var names [][]string
		for _, pipeline := range pipelines {
			var line []string
			for _, cmd := range pipeline {
				line = append(line, cmd.Name()+" "+cmd.Args()[3].(string))
			}
			names = append(names, line)
		}
		return names
	}

	adapter, pipelines := pipelined(ok)
	if err := adapter.InvalidateMany(context.Background(), keys, 1700000000000, 100); err != nil {
		t.Fatal(err)
	}
	if got := shape(*pipelines); !reflect.DeepEqual(got, [][]string{{"evalsha {a}#watermark", "evalsha {b}#watermark", "evalsha {c}#watermark"}}) {
		t.Fatalf("pipelines %v", got)
	}
	for _, cmd := range (*pipelines)[0] {
		if !reflect.DeepEqual(cmd.Args()[4:], []any{"100", "1700000000000"}) || cmd.Args()[1] != invalidationScriptSHA1() {
			t.Fatalf("args %#v", cmd.Args())
		}
	}

	terminal := errors.New("EVAL rejected")
	adapter, pipelines = pipelined(func(cmd redis.Cmder) error {
		key := cmd.Args()[3]
		switch {
		case cmd.Name() == "evalsha" && key != "{b}#watermark":
			return errors.New("NOSCRIPT No matching script")
		case cmd.Name() == "eval" && key == "{c}#watermark":
			return terminal
		}
		return ok(cmd)
	})
	if err := adapter.InvalidateMany(context.Background(), keys, 1700000000000, 100); err != terminal {
		t.Fatalf("err %v", err)
	}
	if got := shape(*pipelines); !reflect.DeepEqual(got, [][]string{
		{"evalsha {a}#watermark", "evalsha {b}#watermark", "evalsha {c}#watermark"},
		{"eval {a}#watermark", "eval {c}#watermark"},
	}) {
		t.Fatalf("pipelines %v", got)
	}
	retry := (*pipelines)[1][0].Args()
	if retry[1] != InvalidationScript || !reflect.DeepEqual(retry[2:], (*pipelines)[0][0].Args()[2:]) {
		t.Fatalf("retry changed logical arguments %#v", retry)
	}

	adapter, pipelines = pipelined(func(cmd redis.Cmder) error {
		cmd.(*redis.Cmd).SetVal("1")
		return nil
	})
	if err := adapter.InvalidateMany(context.Background(), keys, 1, 0); err == nil || len(*pipelines) != 1 {
		t.Fatalf("invalid accepted reply retried: %v %v", err, shape(*pipelines))
	}

	adapter, pipelines = pipelined(ok)
	if err := adapter.InvalidateMany(context.Background(), keys, 1, MaxSupportedDurationMS+1); err == nil || len(*pipelines) != 0 {
		t.Fatalf("invalid buffer dispatched: %v", err)
	}
}
