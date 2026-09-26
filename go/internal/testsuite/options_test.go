package dialcache_test

import (
	"context"
	"errors"
	. "github.com/lan17/DialCache/go"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type recordingAdapter struct {
	events atomic.Int32
	fail   bool
}

func (a *recordingAdapter) ObserveEvent(Event) error {
	a.events.Add(1)
	if a.fail {
		panic("adapter failure")
	}
	return nil
}

func TestObserversFanOutAndMetricsAdapterIsIsolated(t *testing.T) {
	var observed atomic.Int32
	adapter := &recordingAdapter{fail: true}
	cache := MustNew(WithObserver(func(Event) { observed.Add(1) }), WithMetrics(adapter))
	op := Operation[int]{Identity: Identity{KeyType: "item", ID: "one", UseCase: "observers"}}
	// Outside an enabled scope every call reports exactly one disabled event.
	value, err := GetOrLoad(context.Background(), cache, op, func(context.Context) (int, error) { return 7, nil })
	if err != nil || value != 7 {
		t.Fatalf("panicking adapter changed the source result: %d %v", value, err)
	}
	if observed.Load() != 1 || adapter.events.Load() != 1 {
		t.Fatalf("events were not delivered to every observer: observer=%d adapter=%d", observed.Load(), adapter.events.Load())
	}
}

// A JSON null cached through an interface-typed operation is a value for that
// type only. Read back as a non-interface type under the same key it is a
// programming error, reported as a miss with no decisive cause or, for a
// coalescing follower, as ErrValueType, never as a fabricated zero value.
func TestNilInterfaceValueIsNotAHitForOtherTypes(t *testing.T) {
	identity := Identity{KeyType: "item", ID: "shared", UseCase: "nilValue"}
	t.Run("local storage", func(t *testing.T) {
		var misses []string
		cache := MustNew(WithObserver(func(e Event) {
			if e.Kind == "miss" && e.Data["layer"] == "local" {
				misses = append(misses, e.Data["reason"].(string))
			}
		}))
		var sources atomic.Int32
		if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			if v, err := GetOrLoad(ctx, cache, Operation[any]{Identity: identity, Policy: Policy{LocalTTL: 10 * time.Second}}, func(context.Context) (any, error) { sources.Add(1); return nil, nil }); err != nil || v != nil {
				t.Fatalf("nil source result changed: %v %v", v, err)
			}
			if v, err := GetOrLoad(ctx, cache, Operation[any]{Identity: identity, Policy: Policy{LocalTTL: 10 * time.Second}}, func(context.Context) (any, error) { sources.Add(1); return "unexpected", nil }); err != nil || v != nil {
				t.Fatalf("cached nil was not served to the interface type: %v %v", v, err)
			}
			v, err := GetOrLoad(ctx, cache, Operation[string]{Identity: identity, Policy: Policy{LocalTTL: 10 * time.Second}}, func(context.Context) (string, error) { sources.Add(1); return "source", nil })
			if err != nil || v != "source" {
				t.Fatalf("nil interface value served as a string hit: %q %v", v, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if sources.Load() != 2 || len(misses) != 2 || misses[0] != "value_absent" || misses[1] != "unclassified" {
			t.Fatalf("wrong miss accounting: sources=%d misses=%v", sources.Load(), misses)
		}
	})
	t.Run("request memo", func(t *testing.T) {
		cache := MustNew(WithLocalCapacity(0))
		var sources atomic.Int32
		if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			if _, err := GetOrLoad(ctx, cache, Operation[any]{Identity: identity, Policy: Policy{RequestLocal: true}}, func(context.Context) (any, error) { sources.Add(1); return nil, nil }); err != nil {
				t.Fatal(err)
			}
			v, err := GetOrLoad(ctx, cache, Operation[int]{Identity: identity, Policy: Policy{RequestLocal: true}}, func(context.Context) (int, error) { sources.Add(1); return 7, nil })
			if err != nil || v != 7 {
				t.Fatalf("nil memo served as an int hit: %d %v", v, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if sources.Load() != 2 {
			t.Fatalf("memo of another type was reused: sources=%d", sources.Load())
		}
	})
	t.Run("coalescing follower", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			cache := MustNew()
			started, release := make(chan struct{}), make(chan struct{})
			leader := make(chan error, 1)
			follower := make(chan error, 1)
			go func() {
				leader <- cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					_, err := GetOrLoad(ctx, cache, Operation[any]{Identity: identity, Policy: Policy{LocalTTL: 10 * time.Second}}, func(context.Context) (any, error) { close(started); <-release; return nil, nil })
					return err
				})
			}()
			<-started
			go func() {
				follower <- cache.WithEnabled(context.Background(), func(ctx context.Context) error {
					_, err := GetOrLoad(ctx, cache, Operation[string]{Identity: identity, Policy: Policy{LocalTTL: 10 * time.Second}}, func(context.Context) (string, error) { t.Error("follower ran its own source"); return "", nil })
					return err
				})
			}()
			synctest.Wait()
			close(release)
			if err := <-leader; err != nil {
				t.Fatal(err)
			}
			if err := <-follower; !errors.Is(err, ErrValueType) {
				t.Fatalf("follower of another type got %v, want ErrValueType", err)
			}
		})
	})
}
