package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	dialcache "github.com/lan17/DialCache/go"
)

type silentLogger struct{}

func (silentLogger) Debug(string, any) {}
func (silentLogger) Warn(string, any)  {}
func (silentLogger) Error(string, any) {}

type sourceGate struct {
	done      chan struct{}
	once      sync.Once
	followers atomic.Int64
}

func (g *sourceGate) release() { g.once.Do(func() { close(g.done) }) }

type workload struct {
	cache       *dialcache.Cache
	lookup      func(context.Context, string) (string, error)
	source      func(context.Context, string) (string, error)
	sourceCalls atomic.Int64
	coalesced   atomic.Int64
	gate        *sourceGate
}

func newWorkload(req request, namespace string, remote dialcache.Remote) (*workload, error) {
	w := &workload{}
	options := []dialcache.Option{
		dialcache.WithNamespace(namespace), dialcache.WithLocalCapacity(req.Case.Capacity),
		dialcache.WithLogger(silentLogger{}), dialcache.WithoutCompression(),
		dialcache.WithRemoteReadTimeout(60 * time.Second),
	}
	if remote != nil {
		options = append(options, dialcache.WithRemote(remote))
	}
	if isCoalescing(req.Case.Kind) {
		options = append(options, dialcache.WithObserver(func(event dialcache.Event) {
			if event.Kind == "coalesced" {
				w.coalesced.Add(1)
				if w.gate.followers.Add(1) == int64(req.Case.Fanout-1) {
					w.gate.release()
				}
			}
		}))
	}
	cache, err := dialcache.New(options...)
	if err != nil {
		return nil, err
	}
	w.cache = cache
	policy := dialcache.Policy{}
	switch req.Case.Kind {
	case "disabled", "request-local-hit", "request-coalescing":
		policy.RequestLocal = true
	case "process-local-hit", "local-eviction", "process-coalescing":
		policy.LocalTTL = time.Hour
	case "redis-hit", "redis-tracked-hit":
		policy.RemoteTTL = time.Hour
	}
	w.source = func(ctx context.Context, _ string) (string, error) {
		w.sourceCalls.Add(1)
		if isCoalescing(req.Case.Kind) {
			select {
			case <-w.gate.done:
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return req.Payload, nil
	}
	w.lookup, err = dialcache.Cached(cache, dialcache.Operation[string]{
		Identity: dialcache.Identity{KeyType: "benchmark-key", UseCase: "Benchmark", Tracked: req.Case.Kind == "redis-tracked-hit"},
		Policy:   policy, SourceTimeout: 60 * time.Second,
	}, func(key string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: key}, nil
	}, w.source)
	return w, err
}

func (w *workload) scopedLookup(key string) (string, error) {
	ctx, done := w.cache.Enable(context.Background())
	defer done()
	return w.lookup(ctx, key)
}

func validValues(values []string, payload string) bool {
	for _, value := range values {
		if value != payload {
			return false
		}
	}
	return true
}

func runCore(req request, iterations int) (result, error) {
	r := newResult(req, iterations)
	w, err := newWorkload(req, "urn", nil)
	if err != nil {
		return r, err
	}
	keys := make([]string, iterations)
	for i := range keys {
		keys[i] = "key-" + strconv.Itoa(i)
	}
	values := make([]string, int(r.Operations))
	if isCoalescing(req.Case.Kind) {
		start := time.Now()
		for i, key := range keys {
			if err := w.burst(req, key, values[i*req.Case.Fanout:(i+1)*req.Case.Fanout], &r.Checksum); err != nil {
				return r, err
			}
		}
		r.ElapsedNS = time.Since(start).Nanoseconds()
	} else {
		ctx := context.Background()
		done := func() {}
		if req.Case.Scope == "single" {
			ctx, done = w.cache.Enable(ctx)
		}
		defer done()
		switch req.Case.Kind {
		case "request-local-hit":
			value, err := w.lookup(ctx, "shared")
			if err != nil || value != req.Payload {
				return r, fmt.Errorf("prime request-local entry: value valid=%t, error=%v", value == req.Payload, err)
			}
		case "process-local-hit":
			value, err := w.scopedLookup("shared")
			if err != nil || value != req.Payload {
				return r, fmt.Errorf("prime process-local entry: value valid=%t, error=%v", value == req.Payload, err)
			}
		case "local-eviction":
			for i := range req.Case.Capacity {
				value, err := w.scopedLookup("prefill-" + strconv.Itoa(i))
				if err != nil || value != req.Payload {
					return r, fmt.Errorf("prefill local cache: value valid=%t, error=%v", value == req.Payload, err)
				}
			}
			before := w.sourceCalls.Load()
			value, err := w.scopedLookup("prefill-" + strconv.Itoa(req.Case.Capacity-1))
			if err != nil || value != req.Payload || w.sourceCalls.Load() != before {
				return r, errors.New("local prefill did not retain its newest entry")
			}
		}
		w.sourceCalls.Store(0)
		start := time.Now()
		for i, key := range keys {
			var value string
			switch req.Case.Kind {
			case "source-baseline":
				value, err = w.source(ctx, key)
			case "disabled", "enabled-uncached":
				value, err = w.lookup(ctx, "shared")
			case "request-local-hit":
				value, err = w.lookup(ctx, "shared")
			case "process-local-hit":
				value, err = w.scopedLookup("shared")
			case "local-eviction":
				value, err = w.scopedLookup(key)
			default:
				return r, fmt.Errorf("unknown core kind %s", req.Case.Kind)
			}
			if err != nil {
				return r, err
			}
			values[i] = value
			r.Checksum += int64(len(value))
		}
		r.ElapsedNS = time.Since(start).Nanoseconds()
	}
	r.Counters.SourceCalls = w.sourceCalls.Load()
	r.Counters.CoalescedCalls = w.coalesced.Load()
	if req.Case.Kind == "local-eviction" {
		// Distinct-key misses alone also pass with a disabled local cache. These
		// untimed probes prove storage and eviction without altering the report.
		value, err := w.scopedLookup(keys[len(keys)-1])
		if err != nil || value != req.Payload || w.sourceCalls.Load() != r.Counters.SourceCalls {
			return r, errors.New("local cache did not retain its newest measured entry")
		}
		value, err = w.scopedLookup("prefill-0")
		if err != nil || value != req.Payload || w.sourceCalls.Load() != r.Counters.SourceCalls+1 {
			return r, errors.New("local cache did not evict its oldest prefilled entry")
		}
	}
	r.ValueValid = validValues(values, req.Payload)
	return r, nil
}

// The observer opens the source gate only after every follower actually joined.
// Starting goroutines alone would also allow accidental sequential cache hits.
func (w *workload) burst(req request, key string, values []string, checksum *int64) error {
	w.gate = &sourceGate{done: make(chan struct{})}
	defer w.gate.release()
	ctx := context.Background()
	done := func() {}
	if req.Case.Scope == "per-burst" {
		ctx, done = w.cache.Enable(ctx)
	}
	defer done()
	type answer struct {
		value string
		err   error
	}
	answers := make(chan answer, req.Case.Fanout)
	for range req.Case.Fanout {
		go func() {
			var value string
			var err error
			if req.Case.Scope == "per-burst" {
				value, err = w.lookup(ctx, key)
			} else {
				value, err = w.scopedLookup(key)
			}
			answers <- answer{value, err}
		}()
	}
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var firstError error
	for i := range req.Case.Fanout {
		var a answer
		select {
		case a = <-answers:
		case <-timer.C:
			firstError = errors.New("coalescing gate timed out before every follower joined")
			w.gate.release()
			a = <-answers
		}
		if firstError == nil && a.err != nil {
			firstError = a.err
		}
		values[i] = a.value
		*checksum += int64(len(a.value))
	}
	return firstError
}
