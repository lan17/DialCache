package dialcache

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/redis/go-redis/v9"
)

// These native observations intentionally supplement JSON-projected Quint
// traces: a trace value cannot distinguish copied objects from borrowed ones.
func TestBorrowedReferencesSurviveFollowersAndCacheHits(t *testing.T) {
	for _, layer := range []string{"request", "local"} {
		for _, kind := range []string{"pointer", "map"} {
			t.Run(layer+"/"+kind, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					var original any = &struct{ Value int }{7}
					if kind == "map" {
						original = map[string]int{"value": 7}
					}
					cache := MustNew()
					op := Operation[any]{Identity: Identity{KeyType: "item", ID: "borrowed", UseCase: "get"}}
					if layer == "request" {
						op.Policy.RequestLocal = true
					} else {
						op.Policy.LocalTTL = time.Minute
					}
					var calls atomic.Int32
					release := make(chan struct{})
					var releaseOnce sync.Once
					finishSource := func() { releaseOnce.Do(func() { close(release) }) }
					defer finishSource()
					load := func(context.Context) (any, error) {
						calls.Add(1)
						<-release
						return original, nil
					}
					assertBorrowed := func(value any, err error) {
						t.Helper()
						if err != nil || reflect.ValueOf(value).UnsafePointer() != reflect.ValueOf(original).UnsafePointer() {
							t.Fatalf("%s result was copied or failed: %v", kind, err)
						}
					}
					if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
						results := make(chan struct {
							value any
							err   error
						}, 2)
						invoke := func() {
							value, err := GetOrLoad(ctx, cache, op, load)
							results <- struct {
								value any
								err   error
							}{value, err}
						}
						go invoke()
						synctest.Wait()
						go invoke()
						synctest.Wait()
						if calls.Load() != 1 {
							t.Fatalf("followers started %d sources", calls.Load())
						}
						finishSource()
						for i := 0; i < 2; i++ {
							result := <-results
							assertBorrowed(result.value, result.err)
						}
						value, err := GetOrLoad(ctx, cache, op, load)
						assertBorrowed(value, err)
						return nil
					}); err != nil {
						t.Fatal(err)
					}
					if layer == "local" {
						if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
							value, err := GetOrLoad(ctx, cache, op, load)
							assertBorrowed(value, err)
							return nil
						}); err != nil {
							t.Fatal(err)
						}
					}
					if calls.Load() != 1 {
						t.Fatalf("cache hit repeated source: %d", calls.Load())
					}
				})
			})
		}
	}
}

func TestCachedRegistrationAfterInlineUseCase(t *testing.T) {
	cache := MustNew()
	op := Operation[int]{Identity: Identity{KeyType: "item", ID: "same", UseCase: "inlineThenCached"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond}}
	if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
		value, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { return 7, nil })
		if err != nil || value != 7 {
			t.Fatalf("inline call failed: %v %v", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	selector := func(id string) (Identity, error) { return Identity{ID: id}, nil }
	calls := 0
	loader := func(context.Context, string) (int, error) { calls++; return 9, nil }
	bound, err := Cached(cache, op, selector, loader)
	if err != nil {
		t.Fatalf("inline call reserved wrapper registration: %v", err)
	}
	if _, err := Cached(cache, op, selector, loader); err == nil {
		t.Fatal("wrapper registration did not reserve the use case")
	}
	if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
		value, err := bound(ctx, "same")
		if err != nil || value != 7 || calls != 0 {
			t.Fatalf("registered wrapper lost compatible inline entry: %v %v calls=%d", value, err, calls)
		}
		value, err = GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { return 10, nil })
		if err != nil || value != 7 {
			t.Fatalf("registration prevented later inline reuse: %v %v", value, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

type featureContextHook struct {
	redisCommandHook
	process func(context.Context, redis.Cmder) error
}

func (hook featureContextHook) ProcessHook(redis.ProcessHook) redis.ProcessHook {
	return hook.process
}

func TestRedisAdapterForwardsReadContextCancellation(t *testing.T) {
	for _, tracked := range []bool{false, true} {
		name, watermark := "GET", ""
		if tracked {
			name, watermark = "MGET", "watermark"
		}
		t.Run(name, func(t *testing.T) {
			client := redis.NewClient(&redis.Options{Addr: "unused", MaxRetries: -1})
			defer client.Close()
			received := make(chan context.Context, 1)
			abandon := make(chan struct{})
			defer close(abandon)
			client.AddHook(featureContextHook{process: func(ctx context.Context, cmd redis.Cmder) error {
				received <- ctx
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-abandon:
					return errors.New("test stopped observing read")
				}
			}})
			type contextKey struct{}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "metadata"))
			defer cancel()
			finished := make(chan error, 1)
			go func() {
				_, err := NewRedisAdapter(client).Read(ctx, "value", watermark)
				finished <- err
			}()
			var observed context.Context
			select {
			case observed = <-received:
			case err := <-finished:
				t.Fatalf("adapter returned before dispatching the client read: %v", err)
			}
			if observed.Done() != ctx.Done() || observed.Value(contextKey{}) != "metadata" {
				t.Fatal("adapter lost the supplied read context or metadata")
			}
			cancel()
			if err := <-finished; !errors.Is(err, context.Canceled) {
				t.Fatalf("client cancellation did not reach read result: %v", err)
			}
		})
	}
}

type featureValueCodec struct {
	value   any
	decodes *atomic.Int32
}

func (codec featureValueCodec) Encode(any) (Payload, error) {
	return Payload{Bytes: []byte("stable codec token")}, nil
}
func (codec featureValueCodec) Decode(Payload) (any, error) {
	codec.decodes.Add(1)
	return cloneFeatureValue(codec.value), nil
}
func cloneFeatureValue(value any) any {
	switch value := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(value))
		for key, element := range value {
			copy[key] = cloneFeatureValue(element)
		}
		return copy
	case []any:
		copy := make([]any, len(value))
		for index, element := range value {
			copy[index] = cloneFeatureValue(element)
		}
		return copy
	case []byte:
		return append([]byte{}, value...)
	default:
		return value
	}
}

func TestDefaultShadowComparatorNativeValueBoundaries(t *testing.T) {
	cases := []struct {
		name           string
		cached, source any
		equal          bool
	}{
		{"absent versus null", Absent, nil, false},
		{"absent equality", Absent, Absent, true},
		{"null equality", nil, nil, true},
		{"false versus zero", false, 0, false},
		{"NaN equality", math.NaN(), math.NaN(), true},
		{"signed zero", float64(0), math.Copysign(0, -1), false},
		{"nested property order", map[string]any{"a": 1, "b": []any{nil, Absent}}, map[string]any{"b": []any{nil, Absent}, "a": 1}, true},
		{"missing versus absent property", map[string]any{"a": Absent}, map[string]any{}, false},
		{"binary byte equality", []byte{1, 2}, []byte{1, 2}, true},
		{"binary versus numeric array", []byte{1, 2}, []any{1, 2}, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var reads, writes, decodes, sources atomic.Int32
				outcomes := make(chan string, 2)
				frame := Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: []byte("stable codec token")}
				remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
					reads.Add(1)
					return ReadResult{Kind: "hit", Frame: frame}, nil
				}, write: func(Frame) error { writes.Add(1); return nil }}
				cache := MustNew(WithRemote(remote), WithShadowOutcomes(func(event Event) { outcomes <- event.Outcome }))
				full := float64(100)
				op := Operation[any]{Identity: Identity{KeyType: "item", ID: "same", UseCase: "nativeComparator"}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond, Shadow: &ShadowPolicy{Ramp: &full}}, Codec: featureValueCodec{test.cached, &decodes}}
				if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					_, err := GetOrLoad(ctx, cache, op, func(context.Context) (any, error) { sources.Add(1); return test.source, nil })
					return err
				}); err != nil {
					t.Fatal(err)
				}
				want, wantReads := "mismatch", int32(2)
				if test.equal {
					want, wantReads = "match", 1
				}
				if got := <-outcomes; got != want {
					t.Fatalf("default comparator verdict = %s, want %s", got, want)
				}
				synctest.Wait()
				if len(outcomes) != 0 || sources.Load() != 1 || decodes.Load() != 2 || reads.Load() != wantReads || writes.Load() != 0 {
					t.Fatalf("wrong native verdict effects: extra outcomes=%d sources=%d decodes=%d reads=%d writes=%d", len(outcomes), sources.Load(), decodes.Load(), reads.Load(), writes.Load())
				}
			})
		})
	}
}

type featureInspectionSource struct {
	release chan struct{}
	once    sync.Once
	calls   atomic.Int32
	value   string
	err     error
}

func (source *featureInspectionSource) finish() {
	source.once.Do(func() { close(source.release) })
}
func (source *featureInspectionSource) load(context.Context) (string, error) {
	source.calls.Add(1)
	<-source.release
	return source.value, source.err
}

func TestCoalescingInspectionSeparatesKeysInstancesAndRequestWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		first, second := MustNew(), MustNew()
		firstSource := &featureInspectionSource{release: make(chan struct{}), value: "first"}
		sourceError := errors.New("second key failed")
		secondSource := &featureInspectionSource{release: make(chan struct{}), err: sourceError}
		otherInstanceSource := &featureInspectionSource{release: make(chan struct{}), value: "other instance"}
		requestSource := &featureInspectionSource{release: make(chan struct{}), value: "request"}
		for _, source := range []*featureInspectionSource{firstSource, secondSource, otherInstanceSource, requestSource} {
			defer source.finish()
		}
		type result struct {
			value string
			err   error
		}
		operation := func(id string) Operation[string] {
			return Operation[string]{Identity: Identity{KeyType: "item", ID: id, UseCase: "inspection"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond}}
		}
		startProcess := func(cache *Cache, id string, source *featureInspectionSource, count int) <-chan result {
			completed := make(chan result, count)
			for i := 0; i < count; i++ {
				go func() {
					_ = cache.WithEnabled(context.Background(), func(ctx context.Context) error {
						value, err := GetOrLoad(ctx, cache, operation(id), source.load)
						completed <- result{value, err}
						return nil
					})
				}()
			}
			return completed
		}
		assertState := func(cache *Cache, leaders, followers int, ageMS *int64) {
			t.Helper()
			got := cache.GetCoalescingState().Process
			var wantAge time.Duration
			if ageMS != nil {
				wantAge = time.Duration(*ageMS) * time.Millisecond
			}
			if got.ActiveLeaders != leaders || got.ActiveFollowers != followers || got.OldestLeaderAge != wantAge {
				t.Fatalf("inspection = %+v age=%v, want leaders=%d followers=%d age=%v", got, got.OldestLeaderAge, leaders, followers, ageMS)
			}
		}
		assertResults := func(completed <-chan result, count int, value string, err error) {
			t.Helper()
			for i := 0; i < count; i++ {
				got := <-completed
				if got.value != value || got.err != err {
					t.Fatalf("settled result = %+v, want value=%q error=%v", got, value, err)
				}
			}
		}
		assertState(first, 0, 0, nil)
		assertState(second, 0, 0, nil)
		firstResults := startProcess(first, "first", firstSource, 3)
		synctest.Wait()
		time.Sleep(40 * time.Millisecond)
		secondResults := startProcess(first, "second", secondSource, 2)

		// Two request-only callers share within one live request, but must never
		// appear in either instance's process-flight inspection.
		requestResults := make(chan result, 2)
		requestScopeDone := make(chan error, 1)
		go func() {
			requestScopeDone <- second.WithEnabled(context.Background(), func(ctx context.Context) error {
				op := operation("request")
				op.Policy = Policy{RequestLocal: true}
				settled := make(chan result, 2)
				for i := 0; i < 2; i++ {
					go func() {
						value, err := GetOrLoad(ctx, second, op, requestSource.load)
						settled <- result{value, err}
					}()
				}
				for i := 0; i < 2; i++ {
					requestResults <- <-settled
				}
				return nil
			})
		}()
		synctest.Wait()
		age40 := int64(40)
		assertState(first, 2, 3, &age40)
		assertState(second, 0, 0, nil)
		otherResults := startProcess(second, "first", otherInstanceSource, 1)
		synctest.Wait()
		time.Sleep(60 * time.Millisecond)
		age100, age60 := int64(100), int64(60)
		assertState(first, 2, 3, &age100)
		assertState(second, 1, 0, &age60)
		for _, source := range []*featureInspectionSource{firstSource, secondSource, otherInstanceSource, requestSource} {
			if source.calls.Load() != 1 {
				t.Fatalf("source started %d times while inspection was live", source.calls.Load())
			}
		}

		firstSource.finish()
		assertResults(firstResults, 3, "first", nil)
		assertState(first, 1, 1, &age60)
		assertState(second, 1, 0, &age60)
		secondSource.finish()
		assertResults(secondResults, 2, "", sourceError)
		assertState(first, 0, 0, nil)
		assertState(second, 1, 0, &age60)
		requestSource.finish()
		assertResults(requestResults, 2, "request", nil)
		if err := <-requestScopeDone; err != nil {
			t.Fatal(err)
		}
		assertState(second, 1, 0, &age60)
		otherInstanceSource.finish()
		assertResults(otherResults, 1, "other instance", nil)
		assertState(second, 0, 0, nil)
	})
}

func TestRedisAdapterSurfacesInvalidationRetryError(t *testing.T) {
	missingScript := errors.New("NOSCRIPT No matching script. Please use EVAL")
	terminalCause := errors.New("permission denied")
	terminalError := fmt.Errorf("EVAL rejected: %w", terminalCause)
	var calls [][]any
	adapter := hookedRedis(t, func(cmd redis.Cmder) error {
		calls = append(calls, append([]any{}, cmd.Args()...))
		if cmd.Name() == "evalsha" {
			return missingScript
		}
		if cmd.Name() == "eval" {
			return terminalError
		}
		return fmt.Errorf("unexpected mutation command %q", cmd.Name())
	})
	err := adapter.Invalidate(context.Background(), "watermark", 1700000000000, 123)
	if err != terminalError || !errors.Is(err, terminalCause) || errors.Is(err, missingScript) {
		t.Fatalf("Go adapter changed terminal EVAL error identity/cause: %v", err)
	}
	if len(calls) != 2 || calls[0][0] != "evalsha" || calls[1][0] != "eval" || calls[1][1] != InvalidationScript || !reflect.DeepEqual(calls[0][2:], calls[1][2:]) {
		t.Fatalf("fallback did not preserve one logical invalidation: %#v", calls)
	}
}

type featureTaggedCodec struct {
	tag              string
	binary           bool
	encodes, decodes atomic.Int32
}

func (codec *featureTaggedCodec) Encode(value int) (Payload, error) {
	codec.encodes.Add(1)
	return Payload{Bytes: []byte(codec.tag + ":" + strconv.Itoa(value)), Binary: codec.binary}, nil
}
func (codec *featureTaggedCodec) Decode(payload Payload) (int, error) {
	codec.decodes.Add(1)
	if payload.Binary != codec.binary || !strings.HasPrefix(string(payload.Bytes), codec.tag+":") {
		return 0, errors.New("payload reached the wrong native codec")
	}
	return strconv.Atoi(strings.TrimPrefix(string(payload.Bytes), codec.tag+":"))
}

func TestInlineOperationCodecOverridesDefaultOnReadAndWrite(t *testing.T) {
	for _, override := range []bool{false, true} {
		name := "default"
		if override {
			name = "operation"
		}
		t.Run(name, func(t *testing.T) {
			clock := &manualClock{wall: 1700000000000}
			remote := &memoryRemote{clock: clock, values: make(map[string]remoteEntry), watermarks: make(map[string]string)}
			operationCodec := &featureTaggedCodec{tag: "operation", binary: true}
			cache := MustNew(WithClock(clock), WithRemote(remote), WithoutCompression())
			op := Operation[int]{Identity: Identity{Namespace: "urn", KeyType: "item", ID: "same", UseCase: "inlineCodec"}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond}}
			// Without an operation codec the JSON default stores the bare number.
			wantPayload, wantCodecCalls := "7", int32(0)
			if override {
				op.Codec = operationCodec
				wantPayload, wantCodecCalls = "operation:7", 1
			}
			var sources atomic.Int32
			for i := 0; i < 2; i++ {
				if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					value, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { sources.Add(1); return 7, nil })
					if err != nil || value != 7 {
						t.Fatalf("inline codec result: value=%d error=%v", value, err)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			if sources.Load() != 1 || operationCodec.encodes.Load() != wantCodecCalls || operationCodec.decodes.Load() != wantCodecCalls {
				t.Fatalf("codec selection effects: sources=%d operation codec=%d/%d", sources.Load(), operationCodec.encodes.Load(), operationCodec.decodes.Load())
			}
			_, remoteKey, _, err := op.Identity.Keys()
			if err != nil {
				t.Fatal(err)
			}
			remote.mu.Lock()
			stored := append([]byte{}, remote.values[remoteKey].raw...)
			reads, writes := remote.reads, remote.writes
			remote.mu.Unlock()
			frame := DecodeFrame(stored, false, nil)
			if frame.Kind != "hit" || string(frame.Frame.Payload) != wantPayload || frame.Frame.Binary != override || reads != 2 || writes != 1 {
				t.Fatalf("wrong native publication: frame=%+v reads=%d writes=%d", frame, reads, writes)
			}
		})
	}
}

func TestInlinePolicySnapshotsMutableRampPerInvocation(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	finishProvider := func() { once.Do(func() { close(release) }) }
	defer finishProvider()
	var policies, sources atomic.Int32
	cache := MustNew(WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) {
		if policies.Add(1) == 1 {
			close(entered)
			<-release
		}
		return nil, nil
	}))
	ramp := float64(100)
	op := Operation[int]{Identity: Identity{KeyType: "item", ID: "same", UseCase: "inlinePolicy"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond, LocalRamp: &ramp}}
	type result struct {
		value int
		err   error
	}
	invoke := func() result {
		var got result
		got.err = cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			var err error
			got.value, err = GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { return int(sources.Add(1)), nil })
			return err
		})
		return got
	}
	completed := make(chan result, 1)
	go func() { completed <- invoke() }()
	<-entered
	// The provider barrier is reached after validation and snapshot creation.
	// Mutation cannot race the caller's input read; release orders the provider
	// reply and all subsequent policy use after this deliberate input change.
	ramp = 0
	finishProvider()
	if got := <-completed; got.err != nil || got.value != 1 {
		t.Fatalf("first invocation failed: %+v", got)
	}
	if got := invoke(); got.err != nil || got.value != 2 {
		t.Fatalf("later invocation ignored changed default ramp: %+v", got)
	}
	ramp = 100
	if got := invoke(); got.err != nil || got.value != 1 {
		t.Fatalf("first invocation lost its captured caching policy: %+v", got)
	}
	if sources.Load() != 2 || policies.Load() != 3 {
		t.Fatalf("wrong snapshot effects: sources=%d policy resolutions=%d", sources.Load(), policies.Load())
	}
}

func TestCompressionConstructionDefaultsAndExplicitDisable(t *testing.T) {
	resolved, err := ResolveCompressionConfig(nil)
	if err != nil || resolved != (CompressionConfig{ThresholdBytes: 4096, Level: 3}) {
		t.Fatalf("wrong public compression defaults: %+v %v", resolved, err)
	}
	for _, invalid := range []CompressionConfig{{ThresholdBytes: -1, Level: 3}, {ThresholdBytes: 1, Level: 23}} {
		t.Run(fmt.Sprintf("invalid threshold=%d level=%d", invalid.ThresholdBytes, invalid.Level), func(t *testing.T) {
			if _, err := New(WithCompression(invalid)); !errors.Is(err, ErrInvalidOption) {
				t.Fatalf("invalid enabled compression did not reject at construction: %v", err)
			}
		})
	}
	for _, test := range []struct {
		name     string
		length   int
		disabled bool
		outcome  string
	}{
		{"below default threshold", 4093, false, "below_threshold"},
		{"at default threshold", 4094, false, "compressed"},
		{"explicitly disabled", 8192, true, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := strings.Repeat("x", test.length)
			var frame Frame
			var outcomes []string
			var mu sync.Mutex
			remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			}, write: func(written Frame) error {
				mu.Lock()
				defer mu.Unlock()
				frame = Frame{CreatedAtMS: written.CreatedAtMS, Binary: written.Binary, Payload: append([]byte{}, written.Payload...)}
				return nil
			}}
			opts := []Option{WithRemote(remote), WithObserver(func(event Event) {
				if event.Kind == "compression" {
					mu.Lock()
					outcomes = append(outcomes, event.Outcome)
					mu.Unlock()
				}
			})}
			if test.disabled {
				opts = append(opts, WithoutCompression())
			}
			cache := MustNew(opts...)
			op := Operation[string]{Identity: Identity{KeyType: "item", ID: "same", UseCase: "compressionDefaults"}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond}}
			if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
				got, err := GetOrLoad(ctx, cache, op, func(context.Context) (string, error) { return value, nil })
				if err != nil || got != value {
					t.Fatalf("compression changed source result: %v", err)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if test.outcome == "" {
				if len(outcomes) != 0 {
					t.Fatalf("disabled compression reported write outcomes: %v", outcomes)
				}
			} else if !reflect.DeepEqual(outcomes, []string{test.outcome}) {
				t.Fatalf("wrong compression outcome: %v", outcomes)
			}
			rawJSON := `"` + value + `"`
			if test.outcome == "compressed" {
				decoded := DecompressPayload(Payload{Bytes: frame.Payload, Binary: frame.Binary})
				if !frame.Binary || len(frame.Payload) >= len(rawJSON) || decoded.Outcome != "decompressed" || string(decoded.Payload.Bytes) != rawJSON || decoded.Payload.Binary {
					t.Fatalf("default compression did not preserve a smaller text value: %+v", decoded)
				}
			} else if frame.Binary || string(frame.Payload) != rawJSON {
				t.Fatal("raw write unexpectedly compressed or changed serialized JSON")
			}
		})
	}
}

func TestCapacityConstructionOmissionAndBounds(t *testing.T) {
	for _, explicitZero := range []bool{false, true} {
		name := "omitted options keep the defaults"
		if explicitZero {
			name = "explicit local zero disables settled storage"
		}
		t.Run(name, func(t *testing.T) {
			// Omitted options keep the documented defaults. WithLocalCapacity(0)
			// disables storage while retaining coalescing; shadow capacity has no
			// zero mode and rejects it at construction.
			var opts []Option
			if explicitZero {
				opts = append(opts, WithLocalCapacity(0))
			}
			cache := MustNew(opts...)
			wantCapacity := 10000
			if explicitZero {
				wantCapacity = 0
			}
			if cache.settings.localCapacity != wantCapacity || cache.settings.shadowCapacity != 1 {
				t.Fatalf("wrong native construction defaults: local=%d shadow=%d", cache.settings.localCapacity, cache.settings.shadowCapacity)
			}
			op := Operation[int]{Identity: Identity{KeyType: "item", ID: "same", UseCase: "capacityBinding"}, Policy: Policy{LocalTTL: time.Duration(60000) * time.Millisecond}}
			var sources atomic.Int32
			for call := 1; call <= 2; call++ {
				want := 1
				if explicitZero {
					want = call
				}
				if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					value, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { return int(sources.Add(1)), nil })
					if err != nil || value != want {
						t.Fatalf("capacity binding result=%d error=%v, want %d", value, err, want)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			wantSources := int32(1)
			if explicitZero {
				wantSources = 2
			}
			if sources.Load() != wantSources {
				t.Fatalf("wrong retention behavior: source calls=%d", sources.Load())
			}
		})
	}
	for _, test := range []struct {
		name   string
		option Option
	}{
		{"negative local", WithLocalCapacity(-1)},
		{"negative shadow", WithShadowCapacity(-1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := New(test.option); !errors.Is(err, ErrInvalidOption) {
				t.Fatalf("invalid capacity did not reject at construction: %v", err)
			}
		})
	}
}
