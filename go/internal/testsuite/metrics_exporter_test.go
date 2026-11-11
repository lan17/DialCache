package dialcache_test

import (
	"context"
	"strings"
	"testing"
	"time"

	. "github.com/lan17/DialCache/go"
	"github.com/prometheus/client_golang/prometheus"
)

type tagRecorder struct{ tags []map[string]string }

func (r *tagRecorder) record(tags map[string]string) error {
	r.tags = append(r.tags, tags)
	return nil
}
func (r *tagRecorder) Increment(_ string, _ float64, tags map[string]string) error {
	return r.record(tags)
}
func (r *tagRecorder) Histogram(_ string, _ float64, tags map[string]string) error {
	return r.record(tags)
}
func (r *tagRecorder) Distribution(_ string, _ float64, tags map[string]string) error {
	return r.record(tags)
}

func TestDatadogTagValuesCannotAddTagsOrBreakPackets(t *testing.T) {
	client := &tagRecorder{}
	metrics, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "distribution"})
	if err != nil {
		t.Fatal(err)
	}
	cache := MustNew(WithMetrics(metrics))
	ctx, done := cache.Enable(context.Background())
	defer done()
	operation := Operation[string]{Identity: Identity{Namespace: "test", KeyType: "entity|c", ID: "1", UseCase: "lookup,env:prod\n#x@1"}, Policy: Policy{LocalTTL: time.Minute}}
	if _, err := GetOrLoad(ctx, cache, operation, func(context.Context) (string, error) { return "source", nil }); err != nil {
		t.Fatal(err)
	}
	if len(client.tags) == 0 {
		t.Fatal("no metrics recorded")
	}
	for _, tags := range client.tags {
		if tags["use_case"] != "lookup_env:prod__x_1" || tags["key_type"] != "entity_c" {
			t.Fatalf("tags = %v", tags)
		}
		for _, value := range tags {
			if strings.ContainsAny(value, "|@,#\n\r") {
				t.Fatalf("tag value %q keeps a DogStatsD delimiter", value)
			}
		}
	}
}

// faultyCollector describes itself correctly while it registers, then fails
// as the test sets.
type faultyCollector struct {
	prometheus.Counter
	fault *string
}

func (c faultyCollector) Describe(ch chan<- *prometheus.Desc) {
	switch *c.fault {
	case "panic":
		panic("collector failure")
	case "nil descriptor":
		ch <- nil
	default:
		c.Counter.Describe(ch)
	}
}

func TestFaultyRegisteredCollectorFailsConstruction(t *testing.T) {
	for _, fault := range []string{"panic", "nil descriptor"} {
		state := ""
		registry := prometheus.NewRegistry()
		registry.MustRegister(faultyCollector{prometheus.NewCounter(prometheus.CounterOpts{Name: "application_total", Help: "Application counter."}), &state})
		state = fault
		if _, err := NewPrometheusMetrics(registry, "app_"); err == nil {
			t.Fatalf("%s: constructor succeeded; want an error", fault)
		}
	}
}
