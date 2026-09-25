package dialcache

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type boundaryRemote struct {
	read       func(context.Context) (ReadResult, error)
	write      func(Frame) error
	invalidate func() error
}

func (r boundaryRemote) Read(ctx context.Context, _, _ string) (ReadResult, error) {
	return r.read(ctx)
}
func (r boundaryRemote) Write(_ context.Context, _ string, frame Frame, _ time.Duration) error {
	if r.write != nil {
		return r.write(frame)
	}
	return nil
}
func (r boundaryRemote) Invalidate(context.Context, string, int64, int64) error {
	if r.invalidate != nil {
		return r.invalidate()
	}
	return nil
}

type boundaryCodec struct{ encode func(any) (Payload, error) }

func (c boundaryCodec) Encode(value any) (Payload, error) { return c.encode(value) }
func (c boundaryCodec) Decode(payload Payload) (any, error) {
	return (JSONCodec[any]{}).Decode(payload)
}

type boundaryClock struct {
	wall   atomic.Int64
	origin time.Time
}

func (c *boundaryClock) WallMS() int64    { return c.wall.Load() }
func (c *boundaryClock) ElapsedMS() int64 { return time.Since(c.origin).Milliseconds() }

func TestInlineFallbackDeadlineSnapshot(t *testing.T) {
	for _, stage := range []string{"policy", "read"} {
		t.Run(stage, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				admitted, release, sourceRelease := make(chan struct{}), make(chan struct{}), make(chan struct{})
				defer close(sourceRelease)
				var writes atomic.Int64
				remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
					if stage == "read" {
						close(admitted)
						<-release
					}
					return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
				}, write: func(Frame) error { writes.Add(1); return nil }}
				opts := []Option{WithRemote(remote), WithoutCompression(), WithRemoteReadTimeout(time.Second)}
				if stage == "policy" {
					opts = append(opts, WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) { close(admitted); <-release; return nil, nil }))
				}
				cache := MustNew(opts...)
				deadline := int64(10)
				operation := Operation[any]{Identity: Identity{Namespace: "boundary", KeyType: "id", ID: "snapshot", UseCase: "get"}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond}, SourceTimeout: time.Duration(deadline) * time.Millisecond}
				completed := make(chan error, 1)
				go func() {
					completed <- cache.WithEnabled(context.Background(), func(ctx context.Context) error {
						_, err := GetOrLoad(ctx, cache, operation, func(context.Context) (any, error) { <-sourceRelease; return 1, nil })
						return err
					})
				}()
				<-admitted
				// The operation accepted its static options before awaiting external work.
				deadline = 100
				close(release)
				synctest.Wait()
				time.Sleep(11 * time.Millisecond)
				synctest.Wait()
				select {
				case err := <-completed:
					var timeout *FallbackTimeoutError
					if !errors.As(err, &timeout) || timeout.Timeout != 10*time.Millisecond {
						t.Fatalf("accepted 10ms deadline changed: %v", err)
					}
				default:
					t.Error("call remained pending after its accepted 10ms deadline")
				}
				if writes.Load() != 0 {
					t.Fatal("timed-out source published")
				}
			})
		})
	}
}

func TestInvalidWriterTimestampsFailOpenAndReportWriteErrors(t *testing.T) {
	for _, dark := range []bool{false, true} {
		for _, stage := range []string{"before-dump", "after-dump"} {
			for _, invalid := range []int64{-1, int64(MaxSafeInteger) + 1} {
				name := stage + "/" + strconv.FormatInt(invalid, 10)
				if dark {
					name = "dark/" + name
				} else {
					name = "serving/" + name
				}
				t.Run(name, func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						clock := &boundaryClock{origin: time.Now()}
						clock.wall.Store(1)
						if stage == "before-dump" {
							clock.wall.Store(invalid)
						}
						var dumps, writes atomic.Int64
						var eventsMu sync.Mutex
						var events []Event
						outcomes := make(chan Event, 2)
						sourceRelease := make(chan struct{})
						marker := uint64(0)
						remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
							return ReadResult{Kind: "miss", Reason: "value_absent", ObservedWatermarkMS: &marker}, nil
						}, write: func(Frame) error { writes.Add(1); return nil }}
						codec := boundaryCodec{encode: func(value any) (Payload, error) {
							dumps.Add(1)
							if stage == "after-dump" {
								clock.wall.Store(invalid)
							}
							return (JSONCodec[any]{}).Encode(value)
						}}
						cache := MustNew(WithClock(clock), WithRemote(remote), WithoutCompression(), WithShadowOutcomes(func(event Event) { outcomes <- event }), WithObserver(func(event Event) { eventsMu.Lock(); events = append(events, event); eventsMu.Unlock() }))
						operation := Operation[any]{Identity: Identity{Namespace: "boundary", KeyType: "id", ID: "timestamp", UseCase: "get", Tracked: true}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond}, Codec: codec}
						if dark {
							zero, full := float64(0), float64(100)
							operation.Policy.RemoteRamp = &zero
							operation.Policy.Shadow = &ShadowPolicy{Ramp: &full}
						}
						result := make(chan any, 1)
						failures := make(chan error, 1)
						go func() {
							failures <- cache.WithEnabled(context.Background(), func(ctx context.Context) error {
								value, err := GetOrLoad(ctx, cache, operation, func(context.Context) (any, error) { <-sourceRelease; return 7, nil })
								result <- value
								return err
							})
						}()
						synctest.Wait()
						close(sourceRelease)
						synctest.Wait()
						if err := <-failures; err != nil {
							t.Fatalf("cache plumbing replaced source result: %v", err)
						}
						if value := <-result; value != 7 {
							t.Fatalf("source value changed: %v", value)
						}
						expectedDumps := int64(0)
						if stage == "after-dump" {
							expectedDumps = 1
						}
						if dumps.Load() != expectedDumps || writes.Load() != 0 {
							t.Fatalf("dump/write dispatch: got %d/%d want %d/0", dumps.Load(), writes.Load(), expectedDumps)
						}
						if dark {
							select {
							case event := <-outcomes:
								if event.Outcome != "fill_error" {
									t.Fatalf("invalid writer stamp became %q, want fill_error", event.Outcome)
								}
							default:
								t.Fatal("missing dark fill outcome")
							}
						}
						eventsMu.Lock()
						defer eventsMu.Unlock()
						writeErrors := 0
						for _, event := range events {
							if event.Kind == "error" {
								if event.Data["error"] != "cache_write" {
									t.Fatalf("unsupported error classification: %#v", event.Data)
								}
								writeErrors++
							}
						}
						if writeErrors != 1 {
							t.Fatalf("cache_write diagnostics: got %d want 1", writeErrors)
						}
					})
				})
			}
		}
	}
}

func TestInstanceCapacitySafeIntegerBounds(t *testing.T) {
	if strconv.IntSize < 64 {
		return
	} // Larger-than-safe values cannot exist in a 32-bit int.
	maximum := uint64(MaxSafeInteger)
	invalid := int(maximum + 1)
	for name, option := range map[string]Option{"local": WithLocalCapacity(invalid), "shadow": WithShadowCapacity(invalid)} {
		if _, err := New(option); !errors.Is(err, ErrInvalidOption) {
			t.Fatalf("unsafe %s capacity accepted: %v", name, err)
		}
	}
	// Construction sets a capacity bound; it does not preallocate that many entries.
	_ = MustNew(WithLocalCapacity(int(maximum)), WithShadowCapacity(int(maximum)))
}

type boundaryLogger struct {
	warnings, failures atomic.Int64
	panicOnCall        bool
}

func (logger *boundaryLogger) Debug(string, any) {
	if logger.panicOnCall {
		panic("logger failure")
	}
}
func (logger *boundaryLogger) Warn(string, any) {
	logger.warnings.Add(1)
	if logger.panicOnCall {
		panic("logger failure")
	}
}
func (logger *boundaryLogger) Error(string, any) {
	logger.failures.Add(1)
	if logger.panicOnCall {
		panic("logger failure")
	}
}

func TestLoggerFailuresPreserveSourceAndMaintenanceResults(t *testing.T) {
	t.Run("invalidation", func(t *testing.T) {
		logger := &boundaryLogger{panicOnCall: true}
		problem := errors.New("original invalidation failure")
		cache := MustNew(WithRemote(boundaryRemote{invalidate: func() error { return problem }}), WithLogger(logger), WithObserver(func(Event) { panic("observer failure") }))
		if err := cache.Invalidate(context.Background(), Identity{Namespace: "boundary", KeyType: "id", ID: "maintenance"}, 0); err != problem {
			t.Fatalf("maintenance rejection changed: %v", err)
		}
		if logger.warnings.Load() != 1 {
			t.Fatal("missing invalidation warning")
		}
	})
	for _, stage := range []string{"key", "policy", "read", "write"} {
		t.Run(stage, func(t *testing.T) {
			logger := &boundaryLogger{panicOnCall: true}
			problem := errors.New("controlled plumbing failure")
			remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
				if stage == "read" {
					return ReadResult{}, problem
				}
				return ReadResult{Kind: "miss", Reason: "value_absent"}, nil
			}, write: func(Frame) error {
				if stage == "write" {
					return problem
				}
				return nil
			}}
			opts := []Option{WithRemote(remote), WithLogger(logger), WithoutCompression(), WithObserver(func(Event) { panic("observer failure") })}
			if stage == "policy" {
				opts = append(opts, WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) { return nil, problem }))
			}
			operation := Operation[any]{Identity: Identity{Namespace: "boundary", KeyType: "id", ID: "logging", UseCase: "get"}, Policy: Policy{RemoteTTL: time.Duration(60000) * time.Millisecond}}
			if stage == "key" {
				operation.IdentityProvider = func() (Identity, error) { return Identity{}, problem }
			}
			cache := MustNew(opts...)
			var value any
			err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
				var err error
				value, err = GetOrLoad(ctx, cache, operation, func(context.Context) (any, error) { return 7, nil })
				return err
			})
			if err != nil || value != 7 {
				t.Fatalf("observer/logger failure replaced source: value=%v err=%v", value, err)
			}
			if logger.warnings.Load()+logger.failures.Load() != 1 {
				t.Fatalf("missing plumbing diagnostic: warnings=%d errors=%d", logger.warnings.Load(), logger.failures.Load())
			}
		})
	}
	t.Run("recovery predicate", func(t *testing.T) {
		logger := &boundaryLogger{panicOnCall: true}
		sourceError := errors.New("original source failure")
		maximumAge := int64(2000)
		remote := boundaryRemote{read: func(context.Context) (ReadResult, error) {
			return ReadResult{Kind: "hit", Frame: Frame{CreatedAtMS: uint64(time.Now().UnixMilli() - 1500), Payload: []byte("1")}}, nil
		}}
		cache := MustNew(WithRemote(remote), WithLogger(logger), WithoutCompression(), WithStaleRecovery(func(error) (bool, error) { return false, errors.New("predicate failure") }))
		operation := Operation[any]{Identity: Identity{Namespace: "boundary", KeyType: "id", ID: "predicate", UseCase: "get"}, Policy: Policy{RemoteTTL: time.Duration(1000) * time.Millisecond, StaleOnErrorMaxAge: Ptr(time.Duration(maximumAge) * time.Millisecond)}}
		err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			_, err := GetOrLoad(ctx, cache, operation, func(context.Context) (any, error) { return nil, sourceError })
			return err
		})
		if err != sourceError || logger.warnings.Load() != 1 {
			t.Fatalf("predicate/logger changed original rejection: %v warnings=%d", err, logger.warnings.Load())
		}
	})
}

func TestLocalStorageWriteFailureKeepsSourceResult(t *testing.T) {
	logger := &boundaryLogger{panicOnCall: true}
	var writeErrors atomic.Int64
	// Only local storage reads Clock.ElapsedMS; deadlines and diagnostics use
	// PreciseClock.ElapsedTime. Faulting that public clock boundary exercises
	// the real local-write panic isolation without touching private state.
	clock := &boundaryFaultClock{origin: time.Now()}
	cache := MustNew(WithClock(clock), WithLogger(logger), WithObserver(func(event Event) {
		if event.Kind == "error" && event.Data["error"] == "cache_write" {
			writeErrors.Add(1)
		}
	}))
	clock.faultElapsedMS.Store(true)
	operation := Operation[any]{Identity: Identity{Namespace: "boundary", KeyType: "id", ID: "local", UseCase: "get"}, Policy: Policy{LocalTTL: time.Duration(1000) * time.Millisecond}}
	var value any
	err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
		var err error
		value, err = GetOrLoad(ctx, cache, operation, func(context.Context) (any, error) { return 7, nil })
		return err
	})
	if err != nil || value != 7 || writeErrors.Load() != 1 || logger.warnings.Load() != 1 {
		t.Fatalf("local storage failure changed result: %v %v errors=%d warnings=%d", value, err, writeErrors.Load(), logger.warnings.Load())
	}
}

// boundaryFaultClock fails only the whole-millisecond clock that local
// storage reads; precise elapsed time keeps deadlines and durations working.
type boundaryFaultClock struct {
	origin         time.Time
	faultElapsedMS atomic.Bool
}

func (c *boundaryFaultClock) WallMS() int64              { return time.Now().UnixMilli() }
func (c *boundaryFaultClock) ElapsedTime() time.Duration { return time.Since(c.origin) }
func (c *boundaryFaultClock) ElapsedMS() int64 {
	if c.faultElapsedMS.Load() {
		panic("controlled local storage failure")
	}
	return c.ElapsedTime().Milliseconds()
}
