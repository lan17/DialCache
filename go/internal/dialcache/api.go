package dialcache

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Clock separates wall timestamps from elapsed-time expiration and deadlines.
type Clock interface {
	WallMS() int64
	ElapsedMS() int64
}

// PreciseClock optionally preserves fractional milliseconds for deadlines and
// diagnostics. Local TTL uses whole milliseconds from Clock.ElapsedMS.
// ElapsedTime and ElapsedMS must use the same monotonic origin. Existing integer
// clocks remain supported through Clock.ElapsedMS.
type PreciseClock interface {
	ElapsedTime() time.Duration
}

type Timer interface{ Stop() bool }

// TimerClock lets applications supply the timer source corresponding to Clock.
// Callbacks must run at most once; Stop prevents a callback which has not begun.
type TimerClock interface {
	AfterFunc(delayMS int64, callback func()) Timer
}

// DeferredExecutor controls detached work admission without changing its rules.
type DeferredExecutor interface{ Defer(func()) }

type systemClock struct{ origin time.Time }

var processClockOrigin = time.Now()

func newSystemClock() systemClock {
	now := time.Now()
	// Default instances share a millisecond grid, as performance.now does in
	// TypeScript. A nearby aligned origin keeps elapsed time nonnegative even
	// under a synthetic clock whose epoch precedes package initialization.
	phase := now.Sub(processClockOrigin) % time.Millisecond
	if phase < 0 {
		phase += time.Millisecond
	}
	return systemClock{origin: now.Add(-phase)}
}

func (c systemClock) WallMS() int64              { return time.Now().UnixMilli() }
func (c systemClock) ElapsedTime() time.Duration { return time.Since(c.origin) }
func (c systemClock) ElapsedMS() int64           { return c.ElapsedTime().Milliseconds() }
func (c systemClock) AfterFunc(ms int64, f func()) Timer {
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, f)
}

// Remote supplies atomic primary snapshots and complete, client-stamped writes.
// Cancellation requests do not assert that a pending command has stopped.
type Remote interface {
	// Read returns the value at valueKey and, for a tracked read, the watermark
	// at watermarkKey from one atomic primary snapshot.
	Read(ctx context.Context, valueKey, watermarkKey string) (ReadResult, error)
	// Write stores one complete frame with the given TTL in a single native SET.
	Write(ctx context.Context, key string, frame Frame, ttl time.Duration) error
	// Invalidate raises the watermark to the invalidation timestamp plus the
	// future buffer. Both arguments are wire milliseconds.
	Invalidate(ctx context.Context, watermarkKey string, invalidatedAtMS, futureBufferMS int64) error
}

type Payload struct {
	Bytes  []byte
	Binary bool
}

// Codec borrows immutable payloads. Every Decode must produce an independent value.
type Codec[T any] interface {
	Encode(T) (Payload, error)
	Decode(Payload) (T, error)
}

type ContextCodec[T any] interface {
	EncodeContext(context.Context, T) (Payload, error)
	DecodeContext(context.Context, Payload) (T, error)
}

// RecoveryPredicate decides whether one source error may serve a retained
// stale value. A returned error or panic denies recovery.
type RecoveryPredicate func(error) (bool, error)

const (
	// DefaultSourceTimeout bounds a source call when Operation.SourceTimeout is zero.
	DefaultSourceTimeout = 60 * time.Second
	// DefaultRemoteReadTimeout bounds a remote read unless an option or policy overrides it.
	DefaultRemoteReadTimeout = 50 * time.Millisecond
	// NoTimeout disables the source deadline for one operation.
	NoTimeout time.Duration = -1
	// MaxSupportedDuration is the longest TTL, recovery age or future buffer: 365 days.
	MaxSupportedDuration = time.Duration(MaxSupportedDurationMS) * time.Millisecond
	// MaxDeadline is the longest source or read deadline.
	MaxDeadline = time.Duration(MaxDeadlineMS) * time.Millisecond
)

// Operation describes one cached computation producing values of type T.
type Operation[T any] struct {
	Identity Identity
	// IdentityProvider computes the identity per invocation; Cached sets it from
	// the key selector. A failing or reserved computed identity fails open.
	IdentityProvider func() (Identity, error)
	Policy           Policy
	// Codec overrides JSONCodec[T] for this operation's remote payloads.
	Codec Codec[T]
	// SourceTimeout bounds the source call. It must be whole milliseconds; zero
	// means DefaultSourceTimeout and NoTimeout disables the deadline.
	SourceTimeout time.Duration
	// ShouldRecover replaces the instance recovery predicate for this operation.
	ShouldRecover RecoveryPredicate
	// Comparator decides shadow matches; nil compares with SemanticEqual.
	Comparator func(cached, source T) (bool, error)
}

// Event records public diagnostics; Data contains the backend-neutral labels.
type Event struct {
	Kind    string
	Scope   string
	Key     string
	Data    map[string]any
	Seconds float64
	Bytes   int64
	Outcome string
}

type Logger interface {
	Debug(message string, details any)
	Warn(message string, details any)
	Error(message string, details any)
}

// ErrNoRemote reports maintenance that needs a remote adapter.
var ErrNoRemote = errors.New("dialcache: a remote adapter is required")

// ErrReservedUseCase reports the reserved use case "watermark".
var ErrReservedUseCase = errors.New("dialcache: reserved use case \"watermark\"")

// ErrUseCaseRegistered reports a second Cached registration of a use case.
var ErrUseCaseRegistered = errors.New("dialcache: use case is already registered")

// ErrInvalidPolicy wraps static policy validation failures.
var ErrInvalidPolicy = errors.New("dialcache: invalid policy")

// ErrInvalidOperation wraps operation validation failures other than policy.
var ErrInvalidOperation = errors.New("dialcache: invalid operation")

// ErrInvalidOption wraps constructor option validation failures.
var ErrInvalidOption = errors.New("dialcache: invalid option")

// ErrValueType reports a shared in-process value of a different Go type.
var ErrValueType = errors.New("dialcache: cached value has a different type than requested")

type FallbackTimeoutError struct {
	UseCase string
	Timeout time.Duration
}

func (e *FallbackTimeoutError) Error() string {
	return fmt.Sprintf("DialCache fallback timed out for %s after %dms", e.UseCase, e.Timeout.Milliseconds())
}

type RemoteReadTimeoutError struct{ Timeout time.Duration }

func (e *RemoteReadTimeoutError) Error() string {
	return fmt.Sprintf("DialCache Redis read timed out after %dms", e.Timeout.Milliseconds())
}

type CallbackPanicError struct{ Value any }

func (e *CallbackPanicError) Error() string {
	return fmt.Sprintf("DialCache callback panicked: %v", e.Value)
}

type readBudgetKey struct{}

// ReadBudget reports the remote read deadline attached to an adapter context.
func ReadBudget(ctx context.Context) (time.Duration, bool) {
	d, ok := ctx.Value(readBudgetKey{}).(time.Duration)
	return d, ok
}

// settings is the resolved constructor configuration.
type settings struct {
	remote            Remote
	clock             Clock
	namespace         string
	localCapacity     int
	remoteReadTimeout time.Duration
	observers         []func(Event)
	logger            Logger
	policyProvider    PolicyProvider
	shouldRecover     RecoveryPredicate
	shadowCapacity    int
	shadowOutcome     func(Event)
	recoveryOutcome   func(Event)
	compression       *CompressionConfig // nil disables compressed writes
}

// Option configures New. Unset options keep the documented defaults.
type Option func(*settings) error

// WithRemote supplies the shared layer. Without it the cache is local only.
func WithRemote(remote Remote) Option {
	return func(s *settings) error { s.remote = remote; return nil }
}

// WithNamespace sets the logical key namespace; the default is "urn". An empty
// namespace is permitted. Braces are reserved for Redis Cluster hash tags.
func WithNamespace(namespace string) Option {
	return func(s *settings) error {
		if strings.ContainsAny(namespace, "{}") {
			return fmt.Errorf("%w: namespace contains a reserved delimiter", ErrInvalidOption)
		}
		s.namespace = namespace
		return nil
	}
}

// WithLocalCapacity bounds process-local entries across every use case; the
// default is 10,000. Zero disables local storage while keeping coalescing.
func WithLocalCapacity(entries int) Option {
	return func(s *settings) error {
		if entries < 0 || uint64(entries) > MaxSafeInteger {
			return fmt.Errorf("%w: local capacity must be a nonnegative safe integer", ErrInvalidOption)
		}
		s.localCapacity = entries
		return nil
	}
}

// WithRemoteReadTimeout sets the instance remote read deadline in whole
// milliseconds; the default is 50 ms. Policy can override it per use case.
func WithRemoteReadTimeout(timeout time.Duration) Option {
	return func(s *settings) error {
		if timeout <= 0 || timeout > MaxDeadline || timeout%time.Millisecond != 0 {
			return fmt.Errorf("%w: remote read timeout must be whole milliseconds between 1ms and %s", ErrInvalidOption, MaxDeadline)
		}
		s.remoteReadTimeout = timeout
		return nil
	}
}

// WithClock replaces the wall and elapsed clock, mainly for tests.
func WithClock(clock Clock) Option {
	return func(s *settings) error {
		if clock == nil {
			return fmt.Errorf("%w: clock must not be nil", ErrInvalidOption)
		}
		s.clock = clock
		return nil
	}
}

// WithLogger replaces the standard logger. Logger failures are isolated.
func WithLogger(logger Logger) Option {
	return func(s *settings) error {
		if logger == nil {
			return fmt.Errorf("%w: logger must not be nil", ErrInvalidOption)
		}
		s.logger = logger
		return nil
	}
}

// WithObserver receives every backend-neutral diagnostic event. Every
// configured observer and metrics adapter receives each event; panics in an
// observer are ignored.
func WithObserver(observe func(Event)) Option {
	return func(s *settings) error {
		if observe != nil {
			s.observers = append(s.observers, observe)
		}
		return nil
	}
}

// WithMetrics connects a MetricsAdapter such as the Prometheus or DogStatsD
// adapter, isolating its errors and panics from cache and source results.
func WithMetrics(adapter MetricsAdapter) Option {
	return func(s *settings) error {
		if adapter == nil {
			return fmt.Errorf("%w: metrics adapter must not be nil", ErrInvalidOption)
		}
		s.observers = append(s.observers, FailureIsolatedObserver(adapter.ObserveEvent))
		return nil
	}
}

// WithPolicyProvider resolves a sparse runtime policy overlay once per enabled
// invocation. A nil overlay inherits the operation's static policy.
func WithPolicyProvider(provider PolicyProvider) Option {
	return func(s *settings) error { s.policyProvider = provider; return nil }
}

// WithStaleRecovery sets the instance default for which source errors may
// serve a retained stale value. Omitted, only FallbackTimeoutError qualifies.
func WithStaleRecovery(predicate RecoveryPredicate) Option {
	return func(s *settings) error { s.shouldRecover = predicate; return nil }
}

// WithShadowCapacity bounds scheduled or running shadow jobs per instance;
// the default is one. Excess jobs are dropped and reported.
func WithShadowCapacity(jobs int) Option {
	return func(s *settings) error {
		if jobs < 1 || uint64(jobs) > MaxSafeInteger {
			return fmt.Errorf("%w: shadow capacity must be a positive safe integer", ErrInvalidOption)
		}
		s.shadowCapacity = jobs
		return nil
	}
}

// WithShadowOutcomes receives each shadow validation verdict and enables
// shadow admission; without a hook no shadow work is scheduled.
func WithShadowOutcomes(hook func(Event)) Option {
	return func(s *settings) error { s.shadowOutcome = hook; return nil }
}

// WithRecoveryOutcomes receives each stale recovery outcome.
func WithRecoveryOutcomes(hook func(Event)) Option {
	return func(s *settings) error { s.recoveryOutcome = hook; return nil }
}

// WithCompression sets the write-side compression policy. Zero fields keep
// the 4,096-byte threshold and zstd level 3. Reads always accept compressed
// payloads.
func WithCompression(config CompressionConfig) Option {
	return func(s *settings) error {
		resolved, err := ResolveCompressionConfig(&config)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidOption, err)
		}
		s.compression = &resolved
		return nil
	}
}

// WithoutCompression stores every payload uncompressed. Reads still
// decompress marked payloads.
func WithoutCompression() Option {
	return func(s *settings) error { s.compression = nil; return nil }
}
