// wire-client executes one public DialCache operation against real Redis.
// Its input contains logical identity and source values, never encoded frames.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	dialcache "github.com/lan17/DialCache/go"
	"github.com/redis/go-redis/v9"
)

type taggedValue struct {
	Kind  string          `json:"kind"`
	Value json.RawMessage `json:"value"`
	Hex   string          `json:"hex"`
}

type request struct {
	URL            string         `json:"url"`
	Cluster        bool           `json:"cluster"`
	Namespace      string         `json:"namespace"`
	KeyType        string         `json:"keyType"`
	ID             string         `json:"id"`
	UseCase        string         `json:"useCase"`
	Args           map[string]any `json:"args"`
	Tracked        bool           `json:"tracked"`
	Compression    bool           `json:"compression"`
	Codec          string         `json:"codec"`
	WallMS         int64          `json:"wallMs"`
	Op             string         `json:"op"`
	Source         *taggedValue   `json:"source"`
	FutureBufferMS int64          `json:"futureBufferMs"`
}

// Freeze only wall timestamps. Expiration, deadlines and timers retain real
// monotonic time so a stalled dependency cannot freeze the helper's budgets.
type wallClock struct {
	wall   int64
	origin time.Time
}

func (c wallClock) WallMS() int64              { return c.wall }
func (c wallClock) ElapsedMS() int64           { return time.Since(c.origin).Milliseconds() }
func (c wallClock) ElapsedTime() time.Duration { return time.Since(c.origin) }
func (c wallClock) AfterFunc(ms int64, callback func()) dialcache.Timer {
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, callback)
}

type binaryCodec struct{}

func (binaryCodec) Encode(value any) (dialcache.Payload, error) {
	raw, ok := value.([]byte)
	if !ok {
		return dialcache.Payload{}, fmt.Errorf("binary source must be bytes, got %T", value)
	}
	return dialcache.Payload{Bytes: raw, Binary: true}, nil
}

func (binaryCodec) Decode(payload dialcache.Payload) (any, error) {
	if !payload.Binary {
		return nil, errors.New("binary frame must retain its payload type")
	}
	return append([]byte{}, payload.Bytes...), nil
}

func sourceValue(r request) (any, error) {
	if r.Source == nil {
		return nil, errors.New("cache missed without a supplied source")
	}
	if r.Codec == "binary" {
		if r.Source.Kind != "binary" {
			return nil, errors.New("binary source requires hexadecimal bytes")
		}
		return hex.DecodeString(r.Source.Hex)
	}
	switch r.Source.Kind {
	case "undefined":
		// Absent is the public native sentinel, distinct from nil/JSON null.
		return dialcache.Absent, nil
	case "json":
		var value any
		err := json.Unmarshal(r.Source.Value, &value)
		return value, err
	default:
		return nil, errors.New("JSON source requires JSON or undefined")
	}
}

func describeValue(value any, codec string) (map[string]any, error) {
	if codec == "binary" {
		raw, ok := value.([]byte)
		if !ok {
			return nil, fmt.Errorf("binary result must be bytes, got %T", value)
		}
		return map[string]any{"kind": "binary", "hex": hex.EncodeToString(raw)}, nil
	}
	if dialcache.IsAbsent(value) {
		return map[string]any{"kind": "undefined"}, nil
	}
	return map[string]any{"kind": "json", "value": value}, nil
}

// Observe the actual adapter calls without taking over serialization, framing,
// or storage. These records make fail-open write errors visible to the test.
type observedRemote struct {
	native dialcache.Remote
	mu     sync.Mutex
	writes int
	done   int
	fence  *uint64
	err    error
}

func (r *observedRemote) Read(ctx context.Context, value, watermark string) (dialcache.ReadResult, error) {
	result, err := r.native.Read(ctx, value, watermark)
	r.mu.Lock()
	defer r.mu.Unlock()
	if result.Kind == "miss" && result.ObservedWatermarkMS != nil {
		fence := *result.ObservedWatermarkMS
		r.fence = &fence
	}
	return result, err
}

func (r *observedRemote) Write(ctx context.Context, key string, frame dialcache.Frame, ttl time.Duration) error {
	r.mu.Lock()
	r.writes++
	r.mu.Unlock()
	err := r.native.Write(ctx, key, frame, ttl)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.err = err
	} else {
		r.done++
	}
	return err
}

func (r *observedRemote) Invalidate(ctx context.Context, key string, at, buffer int64) error {
	return r.native.Invalidate(ctx, key, at, buffer)
}

func (r *observedRemote) publication(calls int64, tracked bool, wall int64) (int, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	skipped := calls > 0 && tracked && r.fence != nil && uint64(wall) <= *r.fence
	expected := 0
	if calls > 0 && !skipped {
		expected = 1
	}
	if r.err != nil {
		return r.writes, skipped, fmt.Errorf("Redis publication failed: %w", r.err)
	}
	if r.writes != expected || r.done != expected {
		return r.writes, skipped, fmt.Errorf("expected %d completed Redis writes; observed %d calls and %d completions", expected, r.writes, r.done)
	}
	return r.writes, skipped, nil
}

type warnings struct {
	mu       sync.Mutex
	messages []string
}

func (*warnings) Debug(string, any) {}
func (w *warnings) Warn(message string, details any) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.messages = append(w.messages, fmt.Sprint(message, ": ", details))
}
func (w *warnings) Error(message string, details any) { w.Warn(message, details) }
func (w *warnings) snapshot() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string{}, w.messages...)
}

func connect(r request) (redis.UniversalClient, error) {
	if r.Cluster {
		options, err := redis.ParseClusterURL(r.URL)
		if err != nil {
			return nil, err
		}
		options.DialTimeout, options.ReadTimeout, options.WriteTimeout = 5*time.Second, 5*time.Second, 5*time.Second
		options.MaxRetries, options.DialerRetries, options.MaxRedirects = -1, 1, 3
		options.ContextTimeoutEnabled = true
		options.ReadOnly, options.RouteByLatency, options.RouteRandomly = false, false, false
		return redis.NewClusterClient(options), nil
	}
	options, err := redis.ParseURL(r.URL)
	if err != nil {
		return nil, err
	}
	options.DialTimeout, options.ReadTimeout, options.WriteTimeout = 5*time.Second, 5*time.Second, 5*time.Second
	options.MaxRetries, options.DialerRetries = -1, 1
	options.ContextTimeoutEnabled = true
	return redis.NewClient(options), nil
}

func nullableGet(ctx context.Context, client redis.UniversalClient, key string) (*string, error) {
	value, err := client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func run() (err error) {
	var r request
	decoder := json.NewDecoder(os.Stdin)
	if err = decoder.Decode(&r); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected exactly one JSON request")
	}
	if r.WallMS < 0 || uint64(r.WallMS) > dialcache.MaxSafeInteger {
		return errors.New("wallMs must be a nonnegative safe integer")
	}
	if r.FutureBufferMS < 0 || r.FutureBufferMS > dialcache.MaxSupportedDurationMS {
		return errors.New("futureBufferMs exceeds the supported duration")
	}
	if r.Codec != "json" && r.Codec != "binary" {
		return errors.New("codec must be json or binary")
	}
	args, err := dialcache.NormalizeArgs(r.Args)
	if err != nil {
		return err
	}
	identity := dialcache.Identity{Namespace: r.Namespace, KeyType: r.KeyType, ID: r.ID, UseCase: r.UseCase, Args: args, Tracked: r.Tracked}
	_, valueKey, watermarkKey, err := identity.Keys()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := connect(r)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, client.Close()) }()
	if err = client.Ping(ctx).Err(); err != nil {
		return err
	}
	remote := &observedRemote{native: dialcache.NewRedisAdapter(client)}
	logs := &warnings{}
	options := []dialcache.Option{
		dialcache.WithNamespace(r.Namespace), dialcache.WithRemote(remote), dialcache.WithLocalCapacity(0),
		dialcache.WithClock(wallClock{wall: r.WallMS, origin: time.Now()}),
		dialcache.WithRemoteReadTimeout(5 * time.Second), dialcache.WithLogger(logs),
	}
	if r.Compression {
		options = append(options, dialcache.WithCompression(dialcache.CompressionConfig{ThresholdBytes: 1, Level: 3}))
	} else {
		options = append(options, dialcache.WithoutCompression())
	}
	cache, err := dialcache.New(options...)
	if err != nil {
		return err
	}
	var calls atomic.Int64
	result := map[string]any{"valueKey": valueKey, "watermarkKey": nil}
	if watermarkKey != "" {
		result["watermarkKey"] = watermarkKey
	}
	switch r.Op {
	case "get":
		operation := dialcache.Operation[any]{Identity: identity, Policy: dialcache.Policy{RemoteTTL: time.Minute}, SourceTimeout: 5 * time.Second}
		if r.Codec == "binary" {
			operation.Codec = binaryCodec{}
		}
		enabled, done := cache.Enable(ctx)
		defer done()
		value, getErr := dialcache.GetOrLoad(enabled, cache, operation, func(context.Context) (any, error) {
			calls.Add(1)
			return sourceValue(r)
		})
		if getErr != nil {
			return getErr
		}
		result["value"], err = describeValue(value, r.Codec)
		if err != nil {
			return err
		}
	case "invalidate":
		if err = cache.Invalidate(ctx, identity, time.Duration(r.FutureBufferMS)*time.Millisecond); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown operation: %q", r.Op)
	}
	result["writeCalls"], result["writeSkippedByFence"], err = remote.publication(calls.Load(), r.Tracked, r.WallMS)
	if err != nil {
		return err
	}
	frame, err := nullableGet(ctx, client, valueKey)
	if err != nil {
		return err
	}
	result["frameHex"], result["watermark"] = nil, nil
	if frame != nil {
		result["frameHex"] = hex.EncodeToString([]byte(*frame))
	}
	if watermarkKey != "" {
		result["watermark"], err = nullableGet(ctx, client, watermarkKey)
		if err != nil {
			return err
		}
	}
	ttl, err := client.PTTL(ctx, valueKey).Result()
	if err != nil {
		return err
	}
	ttlMS := ttl.Milliseconds()
	if ttl < 0 {
		// go-redis retains Redis's -1/-2 sentinels as unscaled durations.
		ttlMS = int64(ttl)
	}
	result["ttlMs"], result["sourceCalls"], result["warnings"] = ttlMS, calls.Load(), logs.snapshot()
	return json.NewEncoder(os.Stdout).Encode(result)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
