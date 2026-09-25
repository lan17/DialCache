// Package dialcache provides explicitly enabled, layered caching with runtime
// rollout, request coalescing, invalidation, stale recovery and shadow validation.
//
// The full API reference, including aliased type fields and methods, is at
// https://lan17.github.io/DialCache/reference/go/.
package dialcache

import (
	"context"
	"time"

	impl "github.com/lan17/DialCache/go/internal/dialcache"
)

// Clock separates wall timestamps from elapsed-time expiration and deadlines.
type Clock = impl.Clock

// PreciseClock optionally preserves fractional milliseconds for deadlines and
// diagnostics. Local TTL uses whole milliseconds from Clock.ElapsedMS.
// ElapsedTime and ElapsedMS must use the same monotonic origin. Existing integer
// clocks remain supported through Clock.ElapsedMS.
type PreciseClock = impl.PreciseClock

type Timer = impl.Timer

// TimerClock lets applications supply the timer source corresponding to Clock.
// Callbacks must run at most once; Stop prevents a callback which has not begun.
type TimerClock = impl.TimerClock

// DeferredExecutor controls detached work admission without changing its rules.
type DeferredExecutor = impl.DeferredExecutor

// Remote supplies atomic primary snapshots and complete, client-stamped writes.
// Cancellation requests do not assert that a pending command has stopped.
type Remote = impl.Remote

type Payload = impl.Payload

// Codec borrows immutable payloads. Every Decode must produce an independent value.
type Codec[T any] = impl.Codec[T]

type ContextCodec[T any] = impl.ContextCodec[T]

// RecoveryPredicate decides whether one source error may serve a retained
// stale value. A returned error or panic denies recovery.
type RecoveryPredicate = impl.RecoveryPredicate

// DefaultSourceTimeout bounds a source call when Operation.SourceTimeout is zero.
const DefaultSourceTimeout = impl.DefaultSourceTimeout

// DefaultRemoteReadTimeout bounds a remote read unless an option or policy overrides it.
const DefaultRemoteReadTimeout = impl.DefaultRemoteReadTimeout

// NoTimeout disables the source deadline for one operation.
const NoTimeout = impl.NoTimeout

// MaxSupportedDuration is the longest TTL, recovery age or future buffer: 365 days.
const MaxSupportedDuration = impl.MaxSupportedDuration

// MaxDeadline is the longest source or read deadline.
const MaxDeadline = impl.MaxDeadline

// Operation describes one cached computation producing values of type T.
type Operation[T any] = impl.Operation[T]

// Event records public diagnostics; Data contains the backend-neutral labels.
type Event = impl.Event

type Logger = impl.Logger

// ErrNoRemote reports maintenance that needs a remote adapter.
var ErrNoRemote = impl.ErrNoRemote

// ErrReservedUseCase reports the reserved use case "watermark".
var ErrReservedUseCase = impl.ErrReservedUseCase

// ErrUseCaseRegistered reports a second Cached registration of a use case.
var ErrUseCaseRegistered = impl.ErrUseCaseRegistered

// ErrInvalidPolicy wraps static policy validation failures.
var ErrInvalidPolicy = impl.ErrInvalidPolicy

// ErrInvalidOperation wraps operation validation failures other than policy.
var ErrInvalidOperation = impl.ErrInvalidOperation

// ErrInvalidOption wraps constructor option validation failures.
var ErrInvalidOption = impl.ErrInvalidOption

// ErrValueType reports a shared in-process value of a different Go type.
var ErrValueType = impl.ErrValueType

type FallbackTimeoutError = impl.FallbackTimeoutError

type RemoteReadTimeoutError = impl.RemoteReadTimeoutError

type CallbackPanicError = impl.CallbackPanicError

// ReadBudget reports the remote read deadline attached to an adapter context.
func ReadBudget(ctx context.Context) (time.Duration, bool) {
	return impl.ReadBudget(ctx)
}

// Option configures New. Unset options keep the documented defaults.
type Option = impl.Option

// WithRemote supplies the shared layer. Without it the cache is local only.
func WithRemote(remote Remote) Option {
	return impl.WithRemote(remote)
}

// WithNamespace sets the logical key namespace; the default is "urn". An empty
// namespace is permitted. Braces are reserved for Redis Cluster hash tags.
func WithNamespace(namespace string) Option {
	return impl.WithNamespace(namespace)
}

// WithLocalCapacity bounds process-local entries across every use case; the
// default is 10,000. Zero disables local storage while keeping coalescing.
func WithLocalCapacity(entries int) Option {
	return impl.WithLocalCapacity(entries)
}

// WithRemoteReadTimeout sets the instance remote read deadline in whole
// milliseconds; the default is 50 ms. Policy can override it per use case.
func WithRemoteReadTimeout(timeout time.Duration) Option {
	return impl.WithRemoteReadTimeout(timeout)
}

// WithClock replaces the wall and elapsed clock, mainly for tests.
func WithClock(clock Clock) Option {
	return impl.WithClock(clock)
}

// WithLogger replaces the standard logger. Logger failures are isolated.
func WithLogger(logger Logger) Option {
	return impl.WithLogger(logger)
}

// WithObserver receives every backend-neutral diagnostic event. Every
// configured observer and metrics adapter receives each event; panics in an
// observer are ignored.
func WithObserver(observe func(Event)) Option {
	return impl.WithObserver(observe)
}

// WithMetrics connects a MetricsAdapter such as the Prometheus or DogStatsD
// adapter, isolating its errors and panics from cache and source results.
func WithMetrics(adapter MetricsAdapter) Option {
	return impl.WithMetrics(adapter)
}

// WithPolicyProvider resolves a sparse runtime policy overlay once per enabled
// invocation. A nil overlay inherits the operation's static policy.
func WithPolicyProvider(provider PolicyProvider) Option {
	return impl.WithPolicyProvider(provider)
}

// WithStaleRecovery sets the instance default for which source errors may
// serve a retained stale value. Omitted, only FallbackTimeoutError qualifies.
func WithStaleRecovery(predicate RecoveryPredicate) Option {
	return impl.WithStaleRecovery(predicate)
}

// WithShadowCapacity bounds scheduled or running shadow jobs per instance;
// the default is one. Excess jobs are dropped and reported.
func WithShadowCapacity(jobs int) Option {
	return impl.WithShadowCapacity(jobs)
}

// WithShadowOutcomes receives each shadow validation verdict and enables
// shadow admission; without a hook no shadow work is scheduled.
func WithShadowOutcomes(hook func(Event)) Option {
	return impl.WithShadowOutcomes(hook)
}

// WithRecoveryOutcomes receives each stale recovery outcome.
func WithRecoveryOutcomes(hook func(Event)) Option {
	return impl.WithRecoveryOutcomes(hook)
}

// WithCompression sets the write-side compression policy. Zero fields keep
// the 4,096-byte threshold and zstd level 3. Reads always accept compressed
// payloads.
func WithCompression(config CompressionConfig) Option {
	return impl.WithCompression(config)
}

// WithoutCompression stores every payload uncompressed. Reads still
// decompress marked payloads.
func WithoutCompression() Option {
	return impl.WithoutCompression()
}

// Cache is one DialCache instance: a process-local LRU, coalescing table,
// shadow slots and use case registry shared by every value type.
type Cache = impl.Cache

// New constructs a cache. Options are applied in order; an invalid option
// returns an error wrapping ErrInvalidOption.
func New(opts ...Option) (*Cache, error) {
	return impl.New(opts...)
}

// MustNew is New for configuration known to be valid; it panics otherwise.
func MustNew(opts ...Option) *Cache {
	return impl.MustNew(opts...)
}

// GetOrLoad executes one inline loader through the cache chain without
// registering its use case. Outside an enabled scope it calls load directly.
// Returned in-memory values are shared and must be treated as immutable.
func GetOrLoad[T any](ctx context.Context, c *Cache, op Operation[T], load func(context.Context) (T, error)) (T, error) {
	return impl.GetOrLoad(ctx, c, op, load)
}

// ProcessCoalescingState reports the process-scoped single-flight table.
type ProcessCoalescingState = impl.ProcessCoalescingState

type CoalescingState = impl.CoalescingState

// Cached registers a use case once and returns its typed read-through
// function. The key selector runs only for an enabled call and supplies the
// ID and Args; KeyType, UseCase, Tracked and Namespace come from op.Identity.
// The static policy and source timeout are captured at registration.
func Cached[T, Arg any](cache *Cache, op Operation[T], selectKey func(Arg) (Identity, error), source func(context.Context, Arg) (T, error)) (func(context.Context, Arg) (T, error), error) {
	return impl.Cached[T, Arg](cache, op, selectKey, source)
}

const MaxDeadlineMS = impl.MaxDeadlineMS

// Ptr returns a pointer to v, for optional Policy and PolicyOverlay leaves.
func Ptr[T any](v T) *T {
	return impl.Ptr[T](v)
}

// Policy is an operation's static policy. Zero TTLs omit a layer; positive
// TTLs are whole seconds. Pointer leaves distinguish omitted settings, which
// inherit defaults and runtime overlays, from explicit zero or false.
type Policy = impl.Policy

// ShadowPolicy configures detached remote shadow validation.
type ShadowPolicy = impl.ShadowPolicy

// PolicyProvider returns a sparse runtime overlay for one invocation. A nil
// overlay inherits the static policy; an error bypasses caching for the call.
type PolicyProvider = impl.PolicyProvider

// RuntimePolicy is a sparse overlay applied over an operation's static
// policy: either a typed *PolicyOverlay or a JSONPolicy in the configuration
// shape shared with TypeScript.
type RuntimePolicy = impl.RuntimePolicy

// PolicyOverlay is a typed sparse overlay. Nil leaves inherit. Durations must
// be whole seconds for TTLs and recovery ages and whole milliseconds for the
// read timeout; other values are treated as invalid leaves with the same
// narrow consequences as an invalid JSON leaf.
type PolicyOverlay = impl.PolicyOverlay

// JSONPolicy is a runtime overlay in the JSON configuration shape shared with
// TypeScript: ttlSec and ramp layer maps, requestLocal, coalesce,
// staleOnErrorMaxAgeSec, remoteReadTimeoutMs and shadow. Explicit null leaves
// are invalid; Absent leaves inherit.
type JSONPolicy = impl.JSONPolicy

// RawPolicy wraps an arbitrary decoded JSON value as a runtime overlay so a
// configuration service's reply can pass through unchanged. A value that is
// not an object is an invocation-wide policy error, as in TypeScript.
func RawPolicy(value any) RuntimePolicy {
	return impl.RawPolicy(value)
}

type PolicyDefaults = impl.PolicyDefaults

type ResolvedLayer = impl.ResolvedLayer

type ResolvedShadow = impl.ResolvedShadow

type ResolvedPolicy = impl.ResolvedPolicy

// ParsePolicy accepts the static JSON-shaped TypeScript configuration. Explicit
// null leaves remain invalid; nil/Absent for the whole configuration means none.
func ParsePolicy(config any) (Policy, error) {
	return impl.ParsePolicy(config)
}

// ValidatePolicy checks a static policy; failures wrap ErrInvalidPolicy.
func ValidatePolicy(p Policy) error {
	return impl.ValidatePolicy(p)
}

// SnapshotPolicy detaches every optional leaf from mutable caller-owned memory.
func SnapshotPolicy(p Policy) Policy {
	return impl.SnapshotPolicy(p)
}

// ResolvePolicy merges sparse leaves once. A malformed container, boolean or
// read deadline is an invocation-wide error; TTL/ramp errors disable only that
// layer, while an invalid recovery option preserves valid remote serving.
func ResolvePolicy(base Policy, overlay RuntimePolicy, identity Identity, defaults PolicyDefaults) (ResolvedPolicy, error) {
	return impl.ResolvePolicy(base, overlay, identity, defaults)
}

var Absent = impl.Absent

func IsAbsent(value any) bool {
	return impl.IsAbsent(value)
}

const JSONUndefinedSentinel = impl.JSONUndefinedSentinel

// JSONMember and JSONObject preserve object insertion order when byte-identical
// JSON output matters. Integer-index names are emitted first, as in JavaScript.
// A Go map has no insertion order; its other names are emitted in UTF-16 order.
type JSONMember = impl.JSONMember

type JSONObject = impl.JSONObject

// JSONCodec implements the default JSON serializer over JSON-compatible Go
// values and Absent. Object members holding Absent are omitted; array elements
// holding Absent and nonfinite numbers become null. Big integers and cycles
// are errors. Strings contain Unicode scalar values; JSON escapes with unpaired
// UTF-16 surrogates are rejected. JSONCodec[any] preserves this supported domain.
type JSONCodec[T any] = impl.JSONCodec[T]

// SemanticEqual is strict deep equality for the portable value domain: numbers
// are one IEEE-754 type, NaN equals NaN, signed zeros differ, object key order is
// irrelevant, and Absent differs from null. Byte payloads remain typed bytes.
func SemanticEqual(left, right any) bool {
	return impl.SemanticEqual(left, right)
}

const MaxDecompressedBytes = impl.MaxDecompressedBytes

const DefaultCompressionThresholdBytes = impl.DefaultCompressionThresholdBytes

const DefaultZstdLevel = impl.DefaultZstdLevel

type CompressionConfig = impl.CompressionConfig

type CompressionWriteResult = impl.CompressionWriteResult

type CompressionReadResult = impl.CompressionReadResult

func ResolveCompressionConfig(config *CompressionConfig) (CompressionConfig, error) {
	return impl.ResolveCompressionConfig(config)
}

func EscapeRawPayload(payload Payload) Payload {
	return impl.EscapeRawPayload(payload)
}

func CompressPayload(payload Payload, config CompressionConfig, limit ...int) (CompressionWriteResult, error) {
	return impl.CompressPayload(payload, config, limit...)
}

func DecompressPayload(payload Payload, limit ...int) CompressionReadResult {
	return impl.DecompressPayload(payload, limit...)
}
