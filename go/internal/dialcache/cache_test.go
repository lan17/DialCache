package dialcache

import (
	"bytes"
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type binaryCodec struct{}

func (binaryCodec) Encode(value []byte) (Payload, error) {
	return Payload{Bytes: append([]byte{}, value...), Binary: true}, nil
}

func (binaryCodec) Decode(payload Payload) ([]byte, error) {
	if !payload.Binary {
		return nil, errors.New("binary codec received text")
	}
	return append([]byte{}, payload.Bytes...), nil
}

func TestBinaryCodecRemoteRoundTripPreservesBytesAndTag(t *testing.T) {
	clock := &manualClock{wall: 1788868800000}
	remote := &memoryRemote{clock: clock, values: make(map[string]remoteEntry), watermarks: make(map[string]string)}
	cache := MustNew(WithClock(clock), WithRemote(remote), WithLocalCapacity(10000))
	op := Operation[[]byte]{Identity: Identity{Namespace: "urn", KeyType: "user_id", ID: "123", UseCase: "binaryRoundTrip"}, Codec: binaryCodec{}}
	op.Policy.RemoteTTL = time.Minute
	want := []byte{0, 0xff, 0x80, 0xe2, 0x82}
	var sourceCalls atomic.Int64
	load := func(context.Context) ([]byte, error) { sourceCalls.Add(1); return append([]byte{}, want...), nil }
	for call := 0; call < 2; call++ {
		if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
			value, err := GetOrLoad(ctx, cache, op, load)
			if err != nil {
				return err
			}
			if !bytes.Equal(value, want) {
				t.Errorf("call %d: got %x, want %x", call, value, want)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if sourceCalls.Load() != 1 {
		t.Fatalf("remote hit was lost: source invoked %d times", sourceCalls.Load())
	}
}

func TestClosedScopeCannotPublishIntoReplacement(t *testing.T) {
	c := MustNew(WithLocalCapacity(10000))
	op := coreOperation("lifetime")
	op.Policy.RequestLocal = true
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan callResult, 1)
	var detached context.Context
	if err := c.WithEnabled(context.Background(), func(ctx context.Context) error {
		detached = ctx
		go func() {
			value, err := GetOrLoad(ctx, c, op, func(context.Context) (int64, error) { close(started); <-release; return 1, nil })
			done <- callResult{value, err}
		}()
		<-started
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if c.IsEnabled(detached) {
		t.Fatal("closed scope remains enabled")
	}
	if err := c.WithEnabled(context.Background(), func(ctx context.Context) error {
		first, err := GetOrLoad(ctx, c, op, func(context.Context) (int64, error) { return 2, nil })
		if err != nil || first != 2 {
			t.Fatalf("replacement first: %v %v", first, err)
		}
		close(release)
		original := <-done
		if original.value != 1 || original.err != nil {
			t.Fatalf("old source: %+v", original)
		}
		second, err := GetOrLoad(ctx, c, op, func(context.Context) (int64, error) { t.Error("replacement memo lost"); return 3, nil })
		if err != nil || second != 2 {
			t.Fatalf("replacement memo: %v %v", second, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	value, err := GetOrLoad(detached, c, op, func(context.Context) (int64, error) { return 4, nil })
	if err != nil || value != 4 {
		t.Fatalf("detached source: %v %v", value, err)
	}
}

func TestNestedDisablePreservesMemoAndOutsideDoesNotShare(t *testing.T) {
	c := MustNew(WithLocalCapacity(10000))
	op := coreOperation("nested")
	op.Policy.RequestLocal = true
	var calls atomic.Int64
	load := func(context.Context) (int64, error) { return calls.Add(1), nil }
	if err := c.WithEnabled(context.Background(), func(ctx context.Context) error {
		value, err := GetOrLoad(ctx, c, op, load)
		if err != nil || value != 1 {
			t.Fatalf("first: %v %v", value, err)
		}
		return c.WithDisabled(ctx, func(disabled context.Context) error {
			value, err := GetOrLoad(disabled, c, op, load)
			if err != nil || value != 2 {
				t.Fatalf("disabled: %v %v", value, err)
			}
			return c.WithEnabled(disabled, func(reenabled context.Context) error {
				value, err := GetOrLoad(reenabled, c, op, load)
				if err != nil || value != 1 {
					t.Fatalf("reenabled: %v %v", value, err)
				}
				return nil
			})
		})
	}); err != nil {
		t.Fatal(err)
	}
	for expected := int64(3); expected <= 4; expected++ {
		value, err := GetOrLoad(context.Background(), c, op, load)
		if err != nil || value != expected {
			t.Fatalf("outside: %v %v", value, err)
		}
	}
}
