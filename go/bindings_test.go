package dialcache

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

func TestCachedRegistrationAndCapturedDefaults(t *testing.T) {
	c := MustNew()
	ramp := float64(100)
	op := Operation[int]{Identity: Identity{UseCase: "bound", KeyType: "id"}, Policy: Policy{LocalTTL: time.Duration(1000) * time.Millisecond, LocalRamp: &ramp}}
	keyCalls, sourceCalls := 0, 0
	key := func(id int) (Identity, error) {
		keyCalls++
		if id < 0 {
			return Identity{}, errors.New("key unavailable")
		}
		return Identity{ID: "one"}, nil
	}
	source := func(_ context.Context, id int) (int, error) { sourceCalls++; return id, nil }
	bound, err := Cached(c, op, key, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Cached(c, op, key, source); err == nil {
		t.Fatal("duplicate registration accepted")
	}
	ramp = 0
	if v, e := bound(context.Background(), 7); e != nil || v != 7 || keyCalls != 0 {
		t.Fatalf("disabled invocation built key: %v %v %d", v, e, keyCalls)
	}
	err = c.WithEnabled(context.Background(), func(ctx context.Context) error {
		v, e := bound(ctx, 1)
		if e != nil || v != 1 {
			t.Fatalf("first: %v %v", v, e)
		}
		v, e = bound(ctx, 2)
		if e != nil || v != 1 {
			t.Fatalf("mutated default changed registered cache: %v %v", v, e)
		}
		v, e = bound(ctx, -1)
		if e != nil || v != -1 {
			t.Fatalf("key error did not fail open: %v %v", v, e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if sourceCalls != 3 {
		t.Fatalf("sourceCalls=%d", sourceCalls)
	}
}

func TestProcessCoalescingInspectionTracksLiveOwnership(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := MustNew()
		op := Operation[int]{Identity: Identity{UseCase: "inspect", KeyType: "id", ID: "1"}, Policy: Policy{LocalTTL: time.Duration(1000) * time.Millisecond}}
		release := make(chan struct{})
		finished := make(chan struct{}, 2)
		invoke := func() {
			defer func() { finished <- struct{}{} }()
			_ = c.WithEnabled(context.Background(), func(ctx context.Context) error {
				_, e := GetOrLoad(ctx, c, op, func(context.Context) (int, error) { <-release; return 1, nil })
				return e
			})
		}
		go invoke()
		synctest.Wait()
		go invoke()
		synctest.Wait()
		state := c.GetCoalescingState().Process
		if state.ActiveLeaders != 1 || state.ActiveFollowers != 1 {
			t.Fatalf("live snapshot=%+v", state)
		}
		close(release)
		<-finished
		<-finished
		state = c.GetCoalescingState().Process
		if state.ActiveLeaders != 0 || state.ActiveFollowers != 0 || state.OldestLeaderAge != 0 {
			t.Fatalf("settled snapshot=%+v", state)
		}
	})
}
