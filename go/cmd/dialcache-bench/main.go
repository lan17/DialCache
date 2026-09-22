// Command dialcache-bench executes one shared benchmark request per process.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
)

type benchmarkCase struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	Suite        string `json:"suite"`
	Scope        string `json:"scope"`
	Iterations   int    `json:"iterations"`
	Warmup       int    `json:"warmup"`
	Fanout       int    `json:"fanout"`
	Capacity     int    `json:"capacity"`
	PayloadBytes int    `json:"payloadBytes"`
}

type request struct {
	Version  int           `json:"version"`
	ID       string        `json:"id"`
	Case     benchmarkCase `json:"case"`
	Payload  string        `json:"payload"`
	RedisURL *string       `json:"redisUrl"`
}

type counters struct {
	SourceCalls    int64 `json:"sourceCalls"`
	RedisReads     int64 `json:"redisReads"`
	RedisWrites    int64 `json:"redisWrites"`
	CoalescedCalls int64 `json:"coalescedCalls"`
}

type redisCommands struct {
	Get     int64 `json:"get"`
	MGet    int64 `json:"mget"`
	Set     int64 `json:"set"`
	Eval    int64 `json:"eval"`
	EvalSHA int64 `json:"evalsha"`
	Time    int64 `json:"time"`
}

type runtimeInfo struct {
	Version string `json:"version"`
	Workers int    `json:"workers"`
}

type result struct {
	Version       int           `json:"version"`
	ID            string        `json:"id"`
	Port          string        `json:"port"`
	CaseID        string        `json:"caseId"`
	Operations    int64         `json:"operations"`
	ElapsedNS     int64         `json:"elapsedNs"`
	Checksum      int64         `json:"checksum"`
	ValueValid    bool          `json:"valueValid"`
	Counters      counters      `json:"counters"`
	RedisCommands redisCommands `json:"redisCommands"`
	LatencyNS     []int64       `json:"latencyNs"`
	Runtime       runtimeInfo   `json:"runtime"`
}

var caseScopes = map[string]string{
	"source-baseline": "none", "disabled": "none", "enabled-uncached": "single",
	"request-local-hit": "single", "process-local-hit": "per-operation",
	"local-eviction": "per-operation", "request-coalescing": "per-burst",
	"process-coalescing": "per-operation", "redis-hit": "per-operation",
	"redis-tracked-hit": "per-operation", "redis-write": "none",
}

func decodeRequest(input io.Reader) (request, error) {
	var req request
	raw, err := io.ReadAll(io.LimitReader(input, 16<<20))
	if err != nil {
		return req, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, fmt.Errorf("decode request: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return req, errors.New("expected exactly one JSON request")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return req, err
	}
	for _, field := range []string{"version", "id", "case", "payload", "redisUrl"} {
		if _, ok := fields[field]; !ok {
			return req, fmt.Errorf("missing request field %s", field)
		}
	}
	var caseFields map[string]json.RawMessage
	if err := json.Unmarshal(fields["case"], &caseFields); err != nil {
		return req, err
	}
	for _, field := range []string{"id", "kind", "suite", "scope", "iterations", "warmup", "fanout", "capacity", "payloadBytes"} {
		if raw, ok := caseFields[field]; !ok || bytes.Equal(raw, []byte("null")) {
			return req, fmt.Errorf("missing or null case field %s", field)
		}
	}
	return req, req.validate()
}

func (req request) validate() error {
	c := req.Case
	if req.Version != 1 || req.ID == "" || c.ID == "" {
		return errors.New("version 1 and nonempty request/case IDs are required")
	}
	scope, known := caseScopes[c.Kind]
	if !known || c.Scope != scope {
		return fmt.Errorf("unknown kind or incorrect scope: %s / %s", c.Kind, c.Scope)
	}
	suite := "core"
	if strings.HasPrefix(c.Kind, "redis-") {
		suite = "redis"
		if req.RedisURL == nil || *req.RedisURL == "" {
			return errors.New("Redis cases require redisUrl")
		}
	}
	if c.Suite != suite {
		return fmt.Errorf("%s requires suite %s", c.Kind, suite)
	}
	if c.Iterations < 1 || c.Warmup < 0 || c.Capacity < 1 || c.PayloadBytes < 1 || c.Fanout < 1 {
		return errors.New("iterations, capacity, payloadBytes and fanout must be positive; warmup must be nonnegative")
	}
	if isCoalescing(c.Kind) {
		if c.Fanout < 2 {
			return errors.New("coalescing requires at least two callers")
		}
	} else if c.Fanout != 1 {
		return errors.New("non-coalescing cases require fanout 1")
	}
	if len(req.Payload) != c.PayloadBytes || strings.Trim(req.Payload, "x") != "" {
		return errors.New("payload must contain exactly payloadBytes ASCII x bytes")
	}
	return nil
}

func isCoalescing(kind string) bool {
	return kind == "request-coalescing" || kind == "process-coalescing"
}

func newResult(req request, iterations int) result {
	operations := int64(iterations)
	if isCoalescing(req.Case.Kind) {
		operations *= int64(req.Case.Fanout)
	}
	return result{
		Version: 1, ID: req.ID, Port: "go", CaseID: req.Case.ID,
		Operations: operations, LatencyNS: []int64{},
		Runtime: runtimeInfo{Version: runtime.Version(), Workers: runtime.GOMAXPROCS(0)},
	}
}

func validateResult(req request, iterations int, r result) error {
	if !r.ValueValid || r.Checksum != r.Operations*int64(req.Case.PayloadBytes) || r.ElapsedNS <= 0 {
		return errors.New("invalid returned content, checksum or elapsed time")
	}
	want := counters{}
	switch req.Case.Kind {
	case "source-baseline", "disabled", "enabled-uncached", "local-eviction":
		want.SourceCalls = int64(iterations)
	case "request-coalescing", "process-coalescing":
		want.SourceCalls = int64(iterations)
		want.CoalescedCalls = int64(iterations) * int64(req.Case.Fanout-1)
	case "redis-hit", "redis-tracked-hit":
		want.RedisReads = int64(iterations)
	case "redis-write":
		want.RedisWrites = int64(iterations)
	}
	if r.Counters != want {
		return fmt.Errorf("behavior counters = %+v, want %+v", r.Counters, want)
	}
	return nil
}

func execute(req request) (result, error) {
	phase := func(req request, iterations int, name string) (result, error) {
		return runCore(req, iterations)
	}
	if req.Case.Suite == "redis" {
		client, err := connectRedis(*req.RedisURL)
		if err != nil {
			return result{}, err
		}
		defer client.Close()
		phase = func(req request, iterations int, name string) (result, error) {
			return runRedis(req, iterations, client, name)
		}
	}
	if req.Case.Warmup > 0 {
		warm, err := phase(req, req.Case.Warmup, "warmup")
		if err != nil {
			return result{}, fmt.Errorf("warmup: %w", err)
		}
		if err := validateResult(req, req.Case.Warmup, warm); err != nil {
			return result{}, fmt.Errorf("warmup: %w", err)
		}
	}
	r, err := phase(req, req.Case.Iterations, "measured")
	if err != nil {
		return result{}, err
	}
	return r, validateResult(req, req.Case.Iterations, r)
}

func main() {
	runtime.GOMAXPROCS(1)
	req, err := decodeRequest(os.Stdin)
	if err == nil {
		var r result
		r, err = execute(req)
		if err == nil {
			err = json.NewEncoder(os.Stdout).Encode(r)
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dialcache-bench:", err)
		os.Exit(1)
	}
}
