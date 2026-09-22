package main

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func testRequest(kind string) request {
	fanout := 1
	if isCoalescing(kind) {
		fanout = 4
	}
	return request{
		Version: 1, ID: "worker-test", Payload: strings.Repeat("x", 32),
		Case: benchmarkCase{
			ID: kind, Kind: kind, Suite: "core", Scope: caseScopes[kind],
			Iterations: 5, Warmup: 2, Fanout: fanout, Capacity: 2, PayloadBytes: 32,
		},
	}
}

func TestCoreWorkloads(t *testing.T) {
	prior := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(prior)
	for _, kind := range []string{
		"source-baseline", "disabled", "enabled-uncached", "request-local-hit",
		"process-local-hit", "local-eviction", "request-coalescing", "process-coalescing",
	} {
		t.Run(kind, func(t *testing.T) {
			req := testRequest(kind)
			got, err := execute(req)
			if err != nil {
				t.Fatal(err)
			}
			if got.Port != "go" || got.Runtime.Workers != 1 || len(got.LatencyNS) != 0 {
				t.Fatalf("invalid metadata: %+v", got)
			}
			// execute checks full content, checksum and source/follower counts in
			// both independent phases, including fresh-cache priming.
		})
	}
}

func TestRejectInvalidRequests(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missingWarmup", func(m map[string]any) { delete(m["case"].(map[string]any), "warmup") }},
		{"nullWarmup", func(m map[string]any) { m["case"].(map[string]any)["warmup"] = nil }},
		{"missingRedisURL", func(m map[string]any) { delete(m, "redisUrl") }},
		{"unknownKind", func(m map[string]any) { m["case"].(map[string]any)["kind"] = "unknown" }},
		{"wrongScope", func(m map[string]any) { m["case"].(map[string]any)["scope"] = "none" }},
		{"wrongSuite", func(m map[string]any) { m["case"].(map[string]any)["suite"] = "redis" }},
		{"wrongPayload", func(m map[string]any) { m["payload"] = strings.Repeat("y", 32) }},
		{"zeroIterations", func(m map[string]any) { m["case"].(map[string]any)["iterations"] = 0 }},
		{"unknownField", func(m map[string]any) { m["extra"] = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(testRequest("request-local-hit"))
			if err != nil {
				t.Fatal(err)
			}
			var object map[string]any
			if err := json.Unmarshal(raw, &object); err != nil {
				t.Fatal(err)
			}
			test.mutate(object)
			raw, err = json.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := decodeRequest(strings.NewReader(string(raw))); err == nil {
				t.Fatal("accepted an invalid benchmark request")
			}
		})
	}
}
