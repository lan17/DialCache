package dialcache_test

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	dialcache "github.com/lan17/DialCache/go"
	"github.com/redis/go-redis/v9"
)

// These tests are the source of the shared guides' imported code regions.
func TestDocsRequestScope(t *testing.T) {
	// #region request-scope
	cache := dialcache.MustNew()
	var sourceCalls atomic.Int64
	lookup, err := dialcache.Cached(cache, dialcache.Operation[int64]{
		Identity: dialcache.Identity{KeyType: "user", UseCase: "requestScope"},
		// Only request-local storage is enabled: shared layers stay off.
		Policy: dialcache.Policy{RequestLocal: true},
	}, func(id string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: id}, nil
	}, func(context.Context, string) (int64, error) {
		return sourceCalls.Add(1), nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// An ordinary context does not enable caching.
	for _, want := range []int64{1, 2} {
		got, err := lookup(context.Background(), "42")
		if err != nil || got != want {
			t.Fatalf("disabled lookup = %d, %v; want %d", got, err, want)
		}
	}
	ctx, done := cache.Enable(context.Background())
	defer done()
	for range 2 {
		got, err := lookup(ctx, "42")
		if err != nil || got != 3 {
			t.Fatalf("enabled lookup = %d, %v; want 3", got, err)
		}
	}
	done() // Closing the request discards its request-local cache.

	next, closeNext := cache.Enable(context.Background())
	defer closeNext()
	got, err := lookup(next, "42")
	if err != nil || got != 4 || sourceCalls.Load() != 4 {
		t.Fatalf("new request = %d, %v; source calls = %d; want 4", got, err, sourceCalls.Load())
	}
	// #endregion request-scope
}

func TestDocsRuntimePolicy(t *testing.T) {
	// #region runtime-policy
	// A live configuration service would supply a new immutable overlay.
	var overlay atomic.Pointer[dialcache.PolicyOverlay]
	overlay.Store(&dialcache.PolicyOverlay{Coalesce: dialcache.Ptr(false)})
	cache := dialcache.MustNew(dialcache.WithPolicyProvider(
		func(context.Context, dialcache.Identity) (dialcache.RuntimePolicy, error) {
			return overlay.Load(), nil
		},
	))
	var sourceCalls atomic.Int64
	lookup, err := dialcache.Cached(cache, dialcache.Operation[int64]{
		Identity: dialcache.Identity{KeyType: "user", UseCase: "runtimePolicy"},
		Policy:   dialcache.Policy{RequestLocal: true, LocalTTL: 60 * time.Second},
	}, func(id string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: id}, nil
	}, func(context.Context, string) (int64, error) {
		return sourceCalls.Add(1), nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// The sparse overlay inherits the local TTL across separate requests.
	for range 2 {
		ctx, done := cache.Enable(context.Background())
		got, err := lookup(ctx, "42")
		done()
		if err != nil || got != 1 {
			t.Fatalf("inherited policy = %d, %v; want 1", got, err)
		}
	}

	// Nil leaves inherit; pointers preserve explicit false and zero.
	overlay.Store(&dialcache.PolicyOverlay{
		RequestLocal: dialcache.Ptr(false),
		LocalRamp:    dialcache.Ptr(0.0),
	})
	ctx, done := cache.Enable(context.Background())
	defer done()
	for _, want := range []int64{2, 3} {
		got, err := lookup(ctx, "42")
		if err != nil || got != want {
			t.Fatalf("disabled policy = %d, %v; want %d", got, err, want)
		}
	}
	if sourceCalls.Load() != 3 {
		t.Fatalf("source calls = %d; want 3", sourceCalls.Load())
	}
	// #endregion runtime-policy
}

func TestDocsTrackedInvalidation(t *testing.T) {
	url := os.Getenv("DOCS_REDIS_URL")
	if url == "" {
		t.Skip("set DOCS_REDIS_URL to execute the Redis documentation example")
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	options.DialTimeout = 2 * time.Second
	options.ReadTimeout = time.Second
	options.WriteTimeout = time.Second
	options.MaxRetries = -1
	client := redis.NewClient(options)
	t.Cleanup(func() { _ = client.Close() })
	namespace := fmt.Sprintf("docs-go-%d", time.Now().UnixNano())
	identity := dialcache.Identity{
		Namespace: namespace, KeyType: "user", ID: "42", UseCase: "profileVersion", Tracked: true,
	}
	_, valueKey, watermarkKey, err := identity.Keys()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Del(context.Background(), valueKey, watermarkKey).Err(); err != nil {
			t.Errorf("clean up example Redis keys: %v", err)
		}
	})

	// #region tracked-invalidation
	// client is a caller-owned go-redis client with finite connection/command budgets.
	cache := dialcache.MustNew(
		dialcache.WithNamespace(namespace),
		dialcache.WithRemote(dialcache.NewRedisAdapter(client)),
		dialcache.WithRemoteReadTimeout(time.Second),
	)
	var sourceVersion, sourceCalls atomic.Int64
	sourceVersion.Store(1)
	profileVersion, err := dialcache.Cached(cache, dialcache.Operation[int64]{
		Identity: dialcache.Identity{KeyType: "user", UseCase: "profileVersion", Tracked: true},
		// Local layers stay off so every request observes the Redis watermark.
		Policy: dialcache.Policy{RemoteTTL: 60 * time.Second},
	}, func(id string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: id}, nil
	}, func(context.Context, string) (int64, error) {
		sourceCalls.Add(1)
		return sourceVersion.Load(), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	readVersion := func(want int64) {
		t.Helper()
		ctx, done := cache.Enable(context.Background())
		defer done()
		got, err := profileVersion(ctx, "42")
		if err != nil || got != want {
			t.Fatalf("profile version = %d, %v; want %d", got, err, want)
		}
	}

	readVersion(1)
	sourceVersion.Store(2) // Represents a successfully committed source update.
	readVersion(1)
	if sourceCalls.Load() != 1 {
		t.Fatal("the previous value must really be cached before invalidating it")
	}
	if err := cache.Invalidate(context.Background(), dialcache.Identity{
		KeyType: "user", ID: "42",
	}, 0); err != nil {
		t.Fatal(err)
	}
	readVersion(2)
	if sourceCalls.Load() != 2 {
		t.Fatalf("source calls = %d; want 2", sourceCalls.Load())
	}
	// #endregion tracked-invalidation
}
