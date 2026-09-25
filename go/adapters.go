package dialcache

import (
	impl "github.com/lan17/DialCache/go/internal/dialcache"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// RedisAdapter borrows a connected, caller-owned go-redis standalone, Sentinel,
// or Cluster client. It never connects/closes the client or changes its options.
// Set finite client dial/read/write/retry budgets. Cancellation after dispatch
// cannot prove a mutation did not execute; the cache bounds its own wait.
type RedisAdapter = impl.RedisAdapter

func NewRedisAdapter(client redis.UniversalClient) *RedisAdapter {
	return impl.NewRedisAdapter(client)
}

type RedisPayloadError = impl.RedisPayloadError

type RedisProtocolError = impl.RedisProtocolError

func ValidateRedisSetReply(reply any) error {
	return impl.ValidateRedisSetReply(reply)
}

func ValidateRedisInvalidationReply(reply any) error {
	return impl.ValidateRedisInvalidationReply(reply)
}

// InvalidationScript is the version-1 wire invalidation transition. Redis Lua
// numbers exactly represent the accepted safe-integer domain. Invalid arguments
// return before GET/repair; wrong-type keys alone are repairable read failures.
const InvalidationScript = impl.InvalidationScript

// MetricsAdapter consumes only the bounded public diagnostic events. Event.Key
// is never a metric label; exporting logical identities would add cardinality.
type MetricsAdapter = impl.MetricsAdapter

// FailureIsolatedObserver adapts a fallible exporter for WithObserver. Neither
// a returned error nor a panic may replace a source result or start cache work.
func FailureIsolatedObserver(observer func(Event) error) func(Event) {
	return impl.FailureIsolatedObserver(observer)
}

func FailureIsolatedLogger(logger Logger) Logger {
	return impl.FailureIsolatedLogger(logger)
}

const ShadowLogKeyMaxBytes = impl.ShadowLogKeyMaxBytes

const ShadowLogValueMaxBytes = impl.ShadowLogValueMaxBytes

const ShadowLogTruncationMarker = impl.ShadowLogTruncationMarker

func PreviewShadowLogKey(value string) string {
	return impl.PreviewShadowLogKey(value)
}

func PreviewShadowLogJSON(value any) (preview *string) {
	return impl.PreviewShadowLogJSON(value)
}

type ShadowMismatchDetails = impl.ShadowMismatchDetails

func ShadowMismatchLogDetails(key string, cached, source any) ShadowMismatchDetails {
	return impl.ShadowMismatchLogDetails(key, cached, source)
}

// DogStatsDClient leaves transport, buffering, flushing and ownership with the
// caller. Both observation methods are required, matching the TypeScript adapter.
type DogStatsDClient = impl.DogStatsDClient

type DatadogMetricsOptions = impl.DatadogMetricsOptions

type DatadogMetrics = impl.DatadogMetrics

func NewDatadogMetrics(options DatadogMetricsOptions) (*DatadogMetrics, error) {
	return impl.NewDatadogMetrics(options)
}

// PrometheusCollectorSchema fixes the TypeScript adapter wire contract.
type PrometheusCollectorSchema = impl.PrometheusCollectorSchema

func PrometheusCollectorSchemas(prefix string) []PrometheusCollectorSchema {
	return impl.PrometheusCollectorSchemas(prefix)
}

type PrometheusMetrics = impl.PrometheusMetrics

// PrometheusCollectorBinding makes an existing collector's schema explicit.
// Collector must be an individually registered CounterVec or HistogramVec.
// Schema is the caller's assertion about its construction options, including
// histogram buckets: client_golang does not expose those options for an empty
// HistogramVec. The adapter checks the declared schema and public descriptor
// before reuse, without creating a temporary metric series.
type PrometheusCollectorBinding = impl.PrometheusCollectorBinding

// NewPrometheusMetrics creates collectors or reuses an earlier DialCache group.
// Use NewPrometheusMetricsWithBindings to reuse externally created collectors.
func NewPrometheusMetrics(registry *prometheus.Registry, prefix string) (*PrometheusMetrics, error) {
	return impl.NewPrometheusMetrics(registry, prefix)
}

// NewPrometheusMetricsWithBindings validates every supplied binding before
// atomically registering the remaining collectors. Previously observed values
// remain on the same collector objects. As with registry configuration itself,
// callers must not concurrently unregister/reconfigure the supplied collectors
// during construction; concurrent observations remain safe.
func NewPrometheusMetricsWithBindings(registry *prometheus.Registry, prefix string, bindings []PrometheusCollectorBinding) (adapter *PrometheusMetrics, err error) {
	return impl.NewPrometheusMetricsWithBindings(registry, prefix, bindings)
}
