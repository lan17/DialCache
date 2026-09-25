package dialcache_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	dialcache "github.com/lan17/DialCache/go"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// Keep the pre-reorganization public names and method sets available through
// the module root. These checks use only the supported public import.
var (
	_ dialcache.Cache
	_ dialcache.CallbackPanicError
	_ dialcache.Clock
	_ dialcache.CoalescingState
	_ dialcache.Codec[string]
	_ dialcache.CompressionConfig
	_ dialcache.CompressionReadResult
	_ dialcache.CompressionWriteResult
	_ dialcache.ContextCodec[string]
	_ dialcache.DatadogMetrics
	_ dialcache.DatadogMetricsOptions
	_ dialcache.DeferredExecutor
	_ dialcache.DogStatsDClient
	_ dialcache.Event
	_ dialcache.FallbackTimeoutError
	_ dialcache.Frame
	_ dialcache.Identity
	_ dialcache.JSONCodec[string]
	_ dialcache.JSONMember
	_ dialcache.JSONObject
	_ dialcache.JSONPolicy
	_ dialcache.Logger
	_ dialcache.MetricsAdapter
	_ dialcache.Operation[string]
	_ dialcache.Option
	_ dialcache.Payload
	_ dialcache.Policy
	_ dialcache.PolicyDefaults
	_ dialcache.PolicyOverlay
	_ dialcache.PolicyProvider
	_ dialcache.PreciseClock
	_ dialcache.ProcessCoalescingState
	_ dialcache.PrometheusCollectorBinding
	_ dialcache.PrometheusCollectorSchema
	_ dialcache.PrometheusMetrics
	_ dialcache.ReadResult
	_ dialcache.RecoveryPredicate
	_ dialcache.RedisAdapter
	_ dialcache.RedisPayloadError
	_ dialcache.RedisProtocolError
	_ dialcache.Remote
	_ dialcache.RemoteReadTimeoutError
	_ dialcache.ResolvedLayer
	_ dialcache.ResolvedPolicy
	_ dialcache.ResolvedShadow
	_ dialcache.RuntimePolicy
	_ dialcache.ShadowMismatchDetails
	_ dialcache.ShadowPolicy
	_ dialcache.Timer
	_ dialcache.TimerClock

	_ = dialcache.Absent
	_ = dialcache.Cached[string, string]
	_ = dialcache.CeilSupportedCacheTTLMS
	_ = dialcache.Cohort
	_ = dialcache.CompressPayload
	_ = dialcache.DecodeFrame
	_ = dialcache.DecompressPayload
	_ = dialcache.DefaultCompressionThresholdBytes
	_ = dialcache.DefaultRemoteReadTimeout
	_ = dialcache.DefaultSourceTimeout
	_ = dialcache.DefaultZstdLevel
	_ = dialcache.EncodeFrame
	_ = dialcache.ErrInvalidOperation
	_ = dialcache.ErrInvalidOption
	_ = dialcache.ErrInvalidPolicy
	_ = dialcache.ErrNoRemote
	_ = dialcache.ErrReservedUseCase
	_ = dialcache.ErrUseCaseRegistered
	_ = dialcache.ErrValueType
	_ = dialcache.EscapeRawPayload
	_ = dialcache.FailureIsolatedLogger
	_ = dialcache.FailureIsolatedObserver
	_ = dialcache.GetOrLoad[string]
	_ = dialcache.InvalidationScript
	_ = dialcache.IsAbsent
	_ = dialcache.JSONUndefinedSentinel
	_ = dialcache.MaxDeadline
	_ = dialcache.MaxDeadlineMS
	_ = dialcache.MaxDecompressedBytes
	_ = dialcache.MaxSafeInteger
	_ = dialcache.MaxSupportedDuration
	_ = dialcache.MaxSupportedDurationMS
	_ = dialcache.MaxTrackedValueTTLMS
	_ = dialcache.MustNew
	_ = dialcache.New
	_ = dialcache.NewDatadogMetrics
	_ = dialcache.NewPrometheusMetrics
	_ = dialcache.NewPrometheusMetricsWithBindings
	_ = dialcache.NewRedisAdapter
	_ = dialcache.NoTimeout
	_ = dialcache.NormalizeArgs
	_ = dialcache.NormalizeReadResult
	_ = dialcache.ParsePolicy
	_ = dialcache.PreviewShadowLogJSON
	_ = dialcache.PreviewShadowLogKey
	_ = dialcache.PrometheusCollectorSchemas
	_ = dialcache.Ptr[string]
	_ = dialcache.RawPolicy
	_ = dialcache.RawReadResult
	_ = dialcache.ReadBudget
	_ = dialcache.ResolveCompressionConfig
	_ = dialcache.ResolvePolicy
	_ = dialcache.SemanticEqual
	_ = dialcache.ShadowLogKeyMaxBytes
	_ = dialcache.ShadowLogTruncationMarker
	_ = dialcache.ShadowLogValueMaxBytes
	_ = dialcache.ShadowMismatchLogDetails
	_ = dialcache.SnapshotPolicy
	_ = dialcache.ValidatePolicy
	_ = dialcache.ValidateRedisInvalidationReply
	_ = dialcache.ValidateRedisSetReply
	_ = dialcache.ValidateTimestampMS
	_ = dialcache.WithClock
	_ = dialcache.WithCompression
	_ = dialcache.WithLocalCapacity
	_ = dialcache.WithLogger
	_ = dialcache.WithMetrics
	_ = dialcache.WithNamespace
	_ = dialcache.WithObserver
	_ = dialcache.WithPolicyProvider
	_ = dialcache.WithRecoveryOutcomes
	_ = dialcache.WithRemote
	_ = dialcache.WithRemoteReadTimeout
	_ = dialcache.WithShadowCapacity
	_ = dialcache.WithShadowOutcomes
	_ = dialcache.WithStaleRecovery
	_ = dialcache.WithoutCompression

	_ = (*dialcache.Cache).Disable
	_ = (*dialcache.Cache).Enable
	_ = (*dialcache.Cache).GetCoalescingState
	_ = (*dialcache.Cache).Invalidate
	_ = (*dialcache.Cache).IsEnabled
	_ = (*dialcache.Cache).WithDisabled
	_ = (*dialcache.Cache).WithEnabled
	_ = (*dialcache.CallbackPanicError).Error
	_ = (*dialcache.DatadogMetrics).ObserveEvent
	_ = (*dialcache.FallbackTimeoutError).Error
	_ = (*dialcache.Identity).UnmarshalJSON
	_ = (*dialcache.PrometheusMetrics).ObserveEvent
	_ = (*dialcache.RedisAdapter).Invalidate
	_ = (*dialcache.RedisAdapter).InvalidateDecimal
	_ = (*dialcache.RedisAdapter).Read
	_ = (*dialcache.RedisAdapter).Write
	_ = (*dialcache.RedisAdapter).WriteMilliseconds
	_ = (*dialcache.RedisPayloadError).Error
	_ = (*dialcache.RedisProtocolError).Error
	_ = (*dialcache.RemoteReadTimeoutError).Error
	_ = (dialcache.Identity).Keys
	_ = (dialcache.JSONCodec[string]).Decode
	_ = (dialcache.JSONCodec[string]).Encode
	_ = (dialcache.ReadResult).Error

	_ dialcache.Codec[string]  = dialcache.JSONCodec[string]{}
	_ dialcache.Remote         = (*dialcache.RedisAdapter)(nil)
	_ dialcache.MetricsAdapter = (*dialcache.PrometheusMetrics)(nil)
	_ dialcache.MetricsAdapter = (*dialcache.DatadogMetrics)(nil)
	_ dialcache.RuntimePolicy  = (*dialcache.PolicyOverlay)(nil)
	_ dialcache.RuntimePolicy  = dialcache.JSONPolicy(nil)
)

func TestPublicCacheAndErrors(t *testing.T) {
	if _, err := dialcache.New(dialcache.WithLocalCapacity(-1)); !errors.Is(err, dialcache.ErrInvalidOption) {
		t.Fatalf("constructor error = %v; want public ErrInvalidOption", err)
	}
	cache := dialcache.MustNew(dialcache.WithNamespace("public-api"))
	op := dialcache.Operation[string]{
		Identity: dialcache.Identity{KeyType: "user", ID: "42", UseCase: "profile"},
		Policy:   dialcache.Policy{RequestLocal: true, Coalesce: dialcache.Ptr(true)},
		Codec:    dialcache.JSONCodec[string]{},
	}
	ctx, done := cache.Enable(context.Background())
	defer done()
	calls := 0
	load := func(context.Context) (string, error) { calls++; return "profile", nil }
	for range 2 {
		if got, err := dialcache.GetOrLoad(ctx, cache, op, load); err != nil || got != "profile" {
			t.Fatalf("public GetOrLoad = %q, %v", got, err)
		}
	}
	if calls != 1 || !cache.IsEnabled(ctx) || cache.IsEnabled(cache.Disable(ctx)) {
		t.Fatalf("public cache scope failed; source calls = %d", calls)
	}
	if got := cache.GetCoalescingState(); got.Process.ActiveLeaders != 0 || got.Process.ActiveFollowers != 0 {
		t.Fatalf("completed request has active work: %+v", got)
	}
	if err := cache.Invalidate(ctx, op.Identity, 0); !errors.Is(err, dialcache.ErrNoRemote) {
		t.Fatalf("maintenance error = %v; want public ErrNoRemote", err)
	}
	selector := func(id string) (dialcache.Identity, error) { return dialcache.Identity{ID: id}, nil }
	source := func(context.Context, string) (string, error) { return "registered", nil }
	cached, err := dialcache.Cached(cache, op, selector, source)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := cached(ctx, "43"); err != nil || got != "registered" {
		t.Fatalf("public Cached = %q, %v", got, err)
	}
	if _, err := dialcache.Cached(cache, op, selector, source); !errors.Is(err, dialcache.ErrUseCaseRegistered) {
		t.Fatalf("registration error = %v; want public ErrUseCaseRegistered", err)
	}
}

func TestPublicCodecAndProtocol(t *testing.T) {
	codec := dialcache.JSONCodec[any]{}
	payload, err := codec.Encode(dialcache.Absent)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := codec.Decode(payload)
	if err != nil || decoded != dialcache.Absent || !dialcache.IsAbsent(decoded) {
		t.Fatalf("public Absent round trip = %v, %v", decoded, err)
	}
	payload, err = codec.Encode(dialcache.JSONObject{{Name: "value", Value: "round-trip"}})
	if err != nil {
		t.Fatal(err)
	}
	config, err := dialcache.ResolveCompressionConfig(&dialcache.CompressionConfig{ThresholdBytes: 1})
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := dialcache.CompressPayload(payload, config, 1024)
	if err != nil {
		t.Fatal(err)
	}
	uncompressed := dialcache.DecompressPayload(compressed.Payload, 1024)
	if !bytes.Equal(uncompressed.Payload.Bytes, payload.Bytes) || uncompressed.Payload.Binary != payload.Binary {
		t.Fatalf("public payload round trip = %+v", uncompressed)
	}
	frame := dialcache.Frame{CreatedAtMS: 1, Binary: payload.Binary, Payload: payload.Bytes}
	raw, err := dialcache.EncodeFrame(frame)
	if err != nil {
		t.Fatal(err)
	}
	result := dialcache.DecodeFrame(raw, true, nil)
	if result.Kind != "hit" || result.Error() != nil || !bytes.Equal(result.Frame.Payload, payload.Bytes) {
		t.Fatalf("public frame round trip = %+v", result)
	}
}

func TestPublicAdapters(t *testing.T) {
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:0"})
	defer client.Close()
	if adapter := dialcache.NewRedisAdapter(client); adapter == nil {
		t.Fatal("nil Redis adapter")
	}
	var protocolError *dialcache.RedisProtocolError
	if err := dialcache.ValidateRedisSetReply("invalid"); !errors.As(err, &protocolError) {
		t.Fatalf("adapter error = %v; want public RedisProtocolError", err)
	}
	registry := prometheus.NewRegistry()
	metrics, err := dialcache.NewPrometheusMetrics(registry, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dialcache.NewPrometheusMetricsWithBindings(registry, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := metrics.ObserveEvent(dialcache.Event{Kind: "invalidation", Data: map[string]any{"cacheNamespace": "api", "keyType": "user"}}); err != nil {
		t.Fatal(err)
	}
	if samples, err := registry.Gather(); err != nil || len(samples) != 1 {
		t.Fatalf("public metrics = %d families, %v", len(samples), err)
	}
	if _, err := dialcache.NewDatadogMetrics(dialcache.DatadogMetricsOptions{}); err == nil {
		t.Fatal("public Datadog constructor lost validation")
	}
	var timeout error = &dialcache.RemoteReadTimeoutError{Timeout: time.Millisecond}
	var typed *dialcache.RemoteReadTimeoutError
	if !errors.As(timeout, &typed) || typed.Timeout != time.Millisecond {
		t.Fatalf("public error type = %v", timeout)
	}
}
