package dialcache

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ErrCircuitOpen reports a read or write that a circuit breaker rejected
// without calling the wrapped Remote.
var ErrCircuitOpen = errors.New("dialcache: remote circuit is open")

// CircuitState is the state of one circuit of NewCircuitBreaker.
type CircuitState int

const (
	// CircuitClosed passes calls through and counts their outcomes.
	CircuitClosed CircuitState = iota
	// CircuitOpen rejects calls with ErrCircuitOpen.
	CircuitOpen
	// CircuitHalfOpen lets one probe call through and rejects the others.
	CircuitHalfOpen
)

func (s CircuitState) String() string {
	switch s {
	case CircuitClosed:
		return "closed"
	case CircuitOpen:
		return "open"
	case CircuitHalfOpen:
		return "half-open"
	}
	return fmt.Sprintf("CircuitState(%d)", int(s))
}

// CircuitBreakerOptions configures NewCircuitBreaker.
type CircuitBreakerOptions struct {
	// OpenFor is how long an open circuit rejects calls before one probe call
	// may pass. Zero means 5 seconds.
	OpenFor time.Duration
	// OnStateChange receives "read" or "write" and each transition of that
	// circuit. It runs while the circuit is locked, so it must return quickly
	// and must not call the breaker.
	OnStateChange func(operation string, from, to CircuitState)
}

const (
	// circuitWindow is both the minimum number of completed calls before a
	// circuit can open and the number of recent outcomes it judges. Half of
	// them must fail, so at high call rates only a stall longer than half the
	// window opens it, and short blips do not.
	circuitWindow  = 100
	defaultOpenFor = 5 * time.Second
)

// NewCircuitBreaker wraps remote with separate read and write circuits. A
// circuit opens when at least half of its last 100 completed calls failed,
// and never before it has seen 100 calls. While a circuit is open, its calls
// return ErrCircuitOpen at once: the cache then calls the source without
// waiting for the read deadline and skips the Redis fill. After OpenFor, one
// probe call closes the circuit on success or keeps it open on failure.
//
// A read counts as failed when its context ends before it returns, which the
// cache does at the read deadline, so a hung Redis opens the read circuit
// without waiting for the client's own timeout. Payload and protocol errors
// count as successes: Redis answered. A write whose caller context ended is
// not counted as failed. Invalidate always reaches remote and returns its
// error unchanged.
func NewCircuitBreaker(remote Remote, options CircuitBreakerOptions) (Remote, error) {
	if remote == nil {
		return nil, fmt.Errorf("%w: circuit breaker requires a remote", ErrInvalidOption)
	}
	if options.OpenFor < 0 {
		return nil, fmt.Errorf("%w: circuit breaker OpenFor must not be negative", ErrInvalidOption)
	}
	if options.OpenFor == 0 {
		options.OpenFor = defaultOpenFor
	}
	return &circuitBreaker{
		remote: remote,
		read:   &circuit{operation: "read", options: options},
		write:  &circuit{operation: "write", options: options},
	}, nil
}

type circuitBreaker struct {
	remote      Remote
	read, write *circuit
}

func (b *circuitBreaker) Read(ctx context.Context, valueKey, watermarkKey string) (ReadResult, error) {
	generation, ok := b.read.allow()
	if !ok {
		return ReadResult{}, ErrCircuitOpen
	}
	var once sync.Once
	report := func(failed bool) { once.Do(func() { b.read.record(generation, failed) }) }
	// The cache cancels ctx when the read deadline expires; count the read as
	// failed then rather than when the dispatched command returns.
	stop := context.AfterFunc(ctx, func() { report(true) })
	failed := true
	defer func() {
		stop()
		report(failed)
	}()
	result, err := b.remote.Read(ctx, valueKey, watermarkKey)
	failed = remoteFailed(err)
	return result, err
}

func (b *circuitBreaker) Write(ctx context.Context, key string, frame Frame, ttl time.Duration) error {
	generation, ok := b.write.allow()
	if !ok {
		return ErrCircuitOpen
	}
	failed := true
	defer func() { b.write.record(generation, failed) }()
	err := b.remote.Write(ctx, key, frame, ttl)
	failed = remoteFailed(err) && ctx.Err() == nil
	return err
}

func (b *circuitBreaker) Invalidate(ctx context.Context, watermarkKey string, invalidatedAtMS, futureBufferMS int64) error {
	return b.remote.Invalidate(ctx, watermarkKey, invalidatedAtMS, futureBufferMS)
}

func remoteFailed(err error) bool {
	var payload *RedisPayloadError
	var protocol *RedisProtocolError
	return err != nil && !errors.As(err, &payload) && !errors.As(err, &protocol)
}

type circuit struct {
	operation string
	options   CircuitBreakerOptions

	mu    sync.Mutex
	state CircuitState
	// generation advances on every transition, so an outcome from a call
	// admitted in an earlier state is ignored.
	generation uint64
	openedAt   time.Time
	probing    bool
	outcomes   [circuitWindow]bool // true marks a failure
	next       int
	filled     int
	failures   int
}

func (c *circuit) allow() (uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == CircuitOpen && time.Since(c.openedAt) >= c.options.OpenFor {
		c.transition(CircuitHalfOpen)
	}
	switch c.state {
	case CircuitClosed:
		return c.generation, true
	case CircuitHalfOpen:
		if !c.probing {
			c.probing = true
			return c.generation, true
		}
	}
	return 0, false
}

func (c *circuit) record(generation uint64, failed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if generation != c.generation {
		return
	}
	switch c.state {
	case CircuitHalfOpen:
		if failed {
			c.transition(CircuitOpen)
		} else {
			c.transition(CircuitClosed)
		}
	case CircuitClosed:
		if c.filled == circuitWindow {
			if c.outcomes[c.next] {
				c.failures--
			}
		} else {
			c.filled++
		}
		c.outcomes[c.next] = failed
		if failed {
			c.failures++
		}
		c.next = (c.next + 1) % circuitWindow
		if c.filled == circuitWindow && 2*c.failures >= circuitWindow {
			c.transition(CircuitOpen)
		}
	}
}

func (c *circuit) transition(to CircuitState) {
	from := c.state
	c.state = to
	c.generation++
	c.probing = false
	switch to {
	case CircuitOpen:
		c.openedAt = time.Now()
	case CircuitClosed:
		c.outcomes, c.next, c.filled, c.failures = [circuitWindow]bool{}, 0, 0, 0
	}
	if c.options.OnStateChange != nil {
		c.options.OnStateChange(c.operation, from, to)
	}
}
