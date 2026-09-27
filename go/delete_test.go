package dialcache

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

type deleteRemote struct {
	Remote
	remove func(context.Context, string) error
}

func (r deleteRemote) Delete(ctx context.Context, key string) error { return r.remove(ctx, key) }

func TestDeleteExactIdentityAndLiveMemo(t *testing.T) {
	for _, tracked := range []bool{false, true} {
		for _, disabled := range []bool{false, true} {
			var dispatches []string
			var events []Event
			var policyCalls int
			remote := deleteRemote{remove: func(_ context.Context, key string) error { dispatches = append(dispatches, key); return nil }}
			cache := MustNew(WithNamespace("deletion"), WithRemote(remote), WithObserver(func(e Event) { events = append(events, e) }), WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) { policyCalls++; return nil, nil }))
			identity := Identity{KeyType: "id", ID: "42", UseCase: "lookup", Tracked: tracked, Args: [][2]string{{"locale", "en"}}}
			full := identity
			full.Namespace = "deletion"
			key, valueKey, _, err := full.Keys()
			if err != nil {
				t.Fatal(err)
			}
			sibling := full
			sibling.Args = [][2]string{{"locale", "fr"}}
			siblingKey, _, _, _ := sibling.Keys()
			ctx, done := cache.Enable(context.Background())
			defer done()
			state := ctx.Value(cache).(scopeState)
			cache.local.Put(key, 1, 60000)
			cache.local.Put(siblingKey, 2, 60000)
			state.owner.memo[key] = 1
			state.owner.memo[siblingKey] = 2
			flight := &flight{done: make(chan struct{})}
			cache.flights[key] = flight
			state.owner.flights[key] = flight
			if disabled {
				ctx = cache.Disable(ctx)
			}
			if err = cache.Delete(ctx, identity); err != nil {
				t.Fatal(err)
			}
			if _, ok := cache.local.Get(key); ok {
				t.Fatal("local retained exact key")
			}
			if _, ok := state.owner.memo[key]; ok {
				t.Fatal("live memo retained exact key")
			}
			if got, _ := cache.local.Get(siblingKey); got != 2 || state.owner.memo[siblingKey] != 2 {
				t.Fatal("sibling removed")
			}
			if cache.flights[key] != flight || state.owner.flights[key] != flight {
				t.Fatal("delete changed flights")
			}
			if !reflect.DeepEqual(dispatches, []string{valueKey}) || policyCalls != 0 {
				t.Fatalf("dispatch/policy: %v %d", dispatches, policyCalls)
			}
			if len(events) != 1 || events[0].Kind != "deletion" || events[0].Data["layer"] != "remote" || events[0].Data["useCase"] != "lookup" {
				t.Fatalf("events %#v", events)
			}
			if err = cache.Delete(ctx, identity); err != nil {
				t.Fatal("missing entry must succeed", err)
			}
		}
	}
}

func TestDeleteRemoteFirstAndFailureAtomicity(t *testing.T) {
	for _, mode := range []string{"ok", "error", "unsupported", "reserved", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			failure := errors.New("remote failure")
			logger := &boundaryLogger{panicOnCall: true}
			var events []Event
			var cache *Cache
			var calls int
			identity := Identity{Namespace: "urn", KeyType: "id", ID: "42", UseCase: "lookup", Tracked: true}
			key, _, _, _ := identity.Keys()
			var state scopeState
			adapter := deleteRemote{remove: func(_ context.Context, _ string) error {
				calls++
				if got, ok := cache.local.Get(key); !ok || got != 1 || state.owner.memo[key] != 1 {
					t.Fatal("local changed before remote completed")
				}
				if mode == "error" {
					return failure
				}
				return nil
			}}
			var remote Remote = adapter
			if mode == "unsupported" {
				remote = boundaryRemote{}
			}
			cache = MustNew(WithRemote(remote), WithLogger(logger), WithObserver(func(e Event) { events = append(events, e) }))
			ctx, done := cache.Enable(context.Background())
			defer done()
			state = ctx.Value(cache).(scopeState)
			cache.local.Put(key, 1, 60000)
			state.owner.memo[key] = 1
			if mode == "reserved" {
				identity.UseCase = "watermark"
			}
			if mode == "invalid" {
				identity.ID = "{"
			}
			err := cache.Delete(cache.Disable(ctx), identity)
			if mode == "ok" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected failure")
			}
			if got, ok := cache.local.Get(key); !ok || got != 1 || state.owner.memo[key] != 1 {
				t.Fatal("failure removed local state")
			}
			if mode == "error" {
				if err != failure || calls != 1 || logger.warnings.Load() != 1 || len(events) != 2 || events[1].Data["error"] != "deletion" {
					t.Fatalf("failure diagnostics: %v %d %#v", err, calls, events)
				}
			} else if calls != 0 || len(events) != 0 {
				t.Fatal("invalid/unsupported delete reached mutation or counter")
			}
			if mode == "unsupported" && !errors.Is(err, ErrDeleteUnsupported) {
				t.Fatal(err)
			}
			if mode == "reserved" && !errors.Is(err, ErrReservedUseCase) {
				t.Fatal(err)
			}
		})
	}
}
func TestDeleteOutsideAndLocalOnly(t *testing.T) {
	for _, capacity := range []int{0, 2} {
		cache := MustNew(WithLocalCapacity(capacity))
		ctx, done := cache.Enable(context.Background())
		defer done()
		identity := Identity{KeyType: "id", ID: "1", UseCase: "lookup"}
		full := identity
		full.Namespace = "urn"
		key, _, _, _ := full.Keys()
		cache.local.Put(key, 1, 60000)
		state := ctx.Value(cache).(scopeState)
		state.owner.memo[key] = 1
		if err := cache.Delete(context.Background(), identity); err != nil {
			t.Fatal(err)
		}
		if _, ok := cache.local.Get(key); ok {
			t.Fatal("outside delete retained local")
		}
		if state.owner.memo[key] != 1 {
			t.Fatal("outside delete changed another request")
		}
		if err := cache.Delete(cache.Disable(ctx), identity); err != nil {
			t.Fatal(err)
		}
		if _, ok := state.owner.memo[key]; ok {
			t.Fatal("local-only delete retained live memo")
		}
	}
}
func TestDeleteLateSourceStillPublishes(t *testing.T) {
	cache := MustNew()
	ctx, done := cache.Enable(context.Background())
	defer done()
	identity := Identity{KeyType: "id", ID: "1", UseCase: "lookup"}
	op := Operation[int]{Identity: identity, Policy: Policy{LocalTTL: time.Minute, RequestLocal: true}}
	entered, release, result := make(chan struct{}), make(chan struct{}), make(chan int, 1)
	go func() {
		value, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { close(entered); <-release; return 7, nil })
		if err != nil {
			t.Error(err)
		}
		result <- value
	}()
	<-entered
	if err := cache.Delete(ctx, identity); err != nil {
		t.Fatal(err)
	}
	close(release)
	if <-result != 7 {
		t.Fatal("pending caller changed")
	}
	got, err := GetOrLoad(ctx, cache, op, func(context.Context) (int, error) { t.Error("late publication suppressed"); return 9, nil })
	if err != nil || got != 7 {
		t.Fatalf("late value %v %v", got, err)
	}
}
