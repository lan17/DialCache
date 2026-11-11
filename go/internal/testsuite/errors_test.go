package dialcache_test

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	. "github.com/lan17/DialCache/go"
	"github.com/redis/go-redis/v9"
)

type invalidationRemote struct{ key string }

func (*invalidationRemote) Read(context.Context, string, string) (ReadResult, error) {
	return ReadResult{}, nil
}
func (*invalidationRemote) Write(context.Context, string, Frame, time.Duration) error { return nil }
func (r *invalidationRemote) Invalidate(_ context.Context, key string, _, _ int64) error {
	r.key = key
	return nil
}

func TestFallbackTimeoutMatchesDeadlineExceeded(t *testing.T) {
	var err error = &FallbackTimeoutError{UseCase: "read", Timeout: time.Millisecond}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("FallbackTimeoutError does not match context.DeadlineExceeded")
	}
}

func TestInvalidateUsesIdentityNamespace(t *testing.T) {
	_, _, watermark, err := Identity{Namespace: "other", KeyType: "User", ID: "1", Tracked: true}.Keys()
	if err != nil {
		t.Fatal(err)
	}
	remote := &invalidationRemote{}
	cache := MustNew(WithRemote(remote), WithNamespace("default"))
	if err := cache.Invalidate(context.Background(), Identity{Namespace: "other", KeyType: "User", ID: "1"}, 0); err != nil {
		t.Fatal(err)
	}
	if remote.key != watermark {
		t.Fatalf("watermark key %q, want %q", remote.key, watermark)
	}
}

func TestRedisAdapterInvalidationFailureMatchesRemoteUnavailable(t *testing.T) {
	down := errors.New("controlled dial failure")
	client := redis.NewClient(&redis.Options{
		Dialer:     func(context.Context, string, string) (net.Conn, error) { return nil, down },
		MaxRetries: -1,
	})
	defer client.Close()
	err := NewRedisAdapter(client).Invalidate(context.Background(), "{test:User:1}#watermark", 1, 0)
	if !errors.Is(err, ErrRemoteUnavailable) || !errors.Is(err, down) {
		t.Fatalf("got %v", err)
	}
}
