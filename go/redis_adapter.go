package dialcache

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisAdapter borrows a connected, caller-owned go-redis standalone, Sentinel,
// or Cluster client. It never connects/closes the client or changes its options.
// Set finite client dial/read/write/retry budgets. Cancellation after dispatch
// cannot prove a mutation did not execute; the cache bounds its own wait.
// A Sentinel client must keep FailoverOptions.ReplicaOnly false: a replica read
// can hide an invalidation. NewRedisClient rejects it; the adapter cannot see it
// on a client built elsewhere.
type RedisAdapter struct{ client redis.UniversalClient }

func NewRedisAdapter(client redis.UniversalClient) *RedisAdapter {
	return &RedisAdapter{client: client}
}

// NewRedisClient builds a go-redis client for NewRedisAdapter from standard
// go-redis options; redis.NewUniversalClient picks a standalone, Cluster or
// Sentinel client. Zero budget fields get values that fit the default 50 ms read
// budget, and ContextTimeoutEnabled is always set. The caller owns the client
// and closes it after draining cache work.
func NewRedisClient(options *redis.UniversalOptions) (redis.UniversalClient, error) {
	if options == nil {
		return nil, errors.New("dialcache: Redis options are required")
	}
	// go-redis turns ReadOnly on a plain Sentinel client into ReplicaOnly.
	if options.MasterName != "" && options.ReadOnly && !options.RouteByLatency && !options.RouteRandomly && !options.IsClusterMode {
		return nil, errors.New("dialcache: Sentinel ReadOnly reads replicas, which can hide an invalidation")
	}
	budgeted := *options
	defaultTo(&budgeted.Protocol, 2)
	defaultTo(&budgeted.PoolSize, 64)
	defaultTo(&budgeted.MinIdleConns, 8)
	defaultTo(&budgeted.PoolTimeout, 100*time.Millisecond)
	defaultTo(&budgeted.DialTimeout, 500*time.Millisecond)
	defaultTo(&budgeted.DialerRetries, 1)
	defaultTo(&budgeted.ReadTimeout, 250*time.Millisecond)
	defaultTo(&budgeted.WriteTimeout, 250*time.Millisecond)
	defaultTo(&budgeted.MaxRetries, -1)
	defaultTo(&budgeted.ConnMaxIdleTime, 3*time.Minute)
	budgeted.ContextTimeoutEnabled = true
	return redis.NewUniversalClient(&budgeted), nil
}

func defaultTo[T comparable](field *T, value T) {
	var zero T
	if *field == zero {
		*field = value
	}
}

var _ Remote = (*RedisAdapter)(nil)

type RedisPayloadError struct{ Message string }

func (e *RedisPayloadError) Error() string { return e.Message }

type RedisProtocolError struct{ Message string }

func (e *RedisProtocolError) Error() string { return e.Message }

func (adapter *RedisAdapter) Read(ctx context.Context, valueKey, watermarkKey string) (ReadResult, error) {
	var raw any
	var err error
	if watermarkKey == "" {
		raw, err = adapter.client.Get(ctx, valueKey).Result()
		if errors.Is(err, redis.Nil) {
			raw = nil
			err = nil
		}
	} else {
		// Caller options may enable replica reads. Selecting the slot master is
		// explicit here because a stale replica could hide an invalidation fence.
		var commands redis.Cmdable = adapter.client
		if cluster, ok := adapter.client.(*redis.ClusterClient); ok {
			primary, selectErr := cluster.MasterForKey(ctx, valueKey)
			if selectErr != nil {
				return ReadResult{}, selectErr
			}
			commands = primary
		}
		raw, err = commands.MGet(ctx, valueKey, watermarkKey).Result()
	}
	if err != nil {
		return ReadResult{}, err
	}
	var value []byte
	var watermark *string
	if watermarkKey != "" {
		tuple, ok := raw.([]any)
		if !ok || len(tuple) != 2 {
			return ReadResult{}, &RedisPayloadError{"tracked read must return exactly two bulk values"}
		}
		value, err = redisBulk(tuple[0])
		if err != nil {
			return ReadResult{}, err
		}
		marker, markerErr := redisBulk(tuple[1])
		if markerErr != nil {
			return ReadResult{}, markerErr
		}
		if marker != nil {
			text := string(marker)
			watermark = &text
		}
	} else {
		value, err = redisBulk(raw)
		if err != nil {
			return ReadResult{}, err
		}
	}
	result := DecodeFrame(value, watermarkKey != "", watermark)
	if err := result.Error(); err != nil {
		return ReadResult{}, err
	}
	return result, nil
}
func redisBulk(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case nil:
		return nil, nil
	case string:
		return []byte(value), nil
	case []byte:
		return append([]byte{}, value...), nil
	default:
		return nil, &RedisPayloadError{fmt.Sprintf("expected Redis bulk string, got %T", raw)}
	}
}

// Write performs exactly one native SET of the complete frame. It neither
// reads nor modifies the entity watermark. A provided timestamp is exact.
func (adapter *RedisAdapter) Write(ctx context.Context, key string, frame Frame, ttl time.Duration) error {
	return adapter.WriteMilliseconds(ctx, key, frame, float64(ttl)/float64(time.Millisecond))
}
func (adapter *RedisAdapter) WriteMilliseconds(ctx context.Context, key string, frame Frame, ttlMS float64) error {
	ttl, err := CeilSupportedCacheTTLMS(ttlMS)
	if err != nil {
		return err
	}
	raw, err := EncodeFrame(frame)
	if err != nil {
		return err
	}
	reply, err := adapter.client.Do(ctx, "SET", key, raw, "PX", strconv.FormatInt(ttl, 10)).Result()
	if err != nil {
		return err
	}
	return ValidateRedisSetReply(reply)
}
func ValidateRedisSetReply(reply any) error {
	raw, err := redisBulk(reply)
	if err != nil || string(raw) != "OK" {
		return &RedisProtocolError{"invalid Redis SET reply; expected OK"}
	}
	return nil
}
func ValidateRedisInvalidationReply(reply any) error {
	if integer, ok := reply.(int64); !ok || integer != 1 {
		return &RedisProtocolError{"invalid Redis invalidation reply; expected integer 1"}
	}
	return nil
}

// Invalidate keeps the caller's application-clock timestamp stable throughout
// one logical dispatch. EVALSHA failure gets one EVAL retry; accepted but invalid
// replies are errors and are never retried. The monotonic script is idempotent
// even if the first command executed before its response was lost.
func (adapter *RedisAdapter) Invalidate(ctx context.Context, key string, invalidatedAtMS, futureMS int64) error {
	if futureMS < 0 || futureMS > MaxSupportedDurationMS {
		return errors.New("invalid future buffer")
	}
	if invalidatedAtMS < 0 || uint64(invalidatedAtMS) > MaxSafeInteger || uint64(invalidatedAtMS) > MaxSafeInteger-uint64(futureMS) {
		return errors.New("invalid invalidation timestamp")
	}
	return adapter.InvalidateDecimal(ctx, key, strconv.FormatInt(futureMS, 10), strconv.FormatInt(invalidatedAtMS, 10))
}

// InvalidateDecimal exposes the script's raw decimal boundary for out-of-band
// tooling and conformance replay. Validation inside Lua precedes every mutation.
func (adapter *RedisAdapter) InvalidateDecimal(ctx context.Context, key, futureMS, invalidatedAtMS string) error {
	digest := sha1.Sum([]byte(InvalidationScript))
	hash := hex.EncodeToString(digest[:])
	reply, err := adapter.client.EvalSha(ctx, hash, []string{key}, futureMS, invalidatedAtMS).Result()
	if err != nil {
		reply, err = adapter.client.Eval(ctx, InvalidationScript, []string{key}, futureMS, invalidatedAtMS).Result()
	}
	if err != nil {
		return err
	}
	return ValidateRedisInvalidationReply(reply)
}

// InvalidationScript is the version-1 wire invalidation transition. Redis Lua
// numbers exactly represent the accepted safe-integer domain. Invalid arguments
// return before GET/repair; wrong-type keys alone are repairable read failures.
const InvalidationScript = `local function parse_safe_integer(raw)
  if not string.match(raw, "^%d+$") then return nil end
  local value = tonumber(raw)
  if not value or value > 9007199254740991 then return nil end
  return value
end
local future_buffer_ms = parse_safe_integer(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > 31536000000 then
  return redis.error_reply("ERR invalid DialCache future buffer")
end
local invalidated_at_ms = parse_safe_integer(ARGV[2])
if not invalidated_at_ms or invalidated_at_ms > 9007199254740991 - future_buffer_ms then
  return redis.error_reply("ERR invalid DialCache invalidatedAtMs")
end
local proposed_watermark = invalidated_at_ms + future_buffer_ms
local raw_watermark = redis.pcall("GET", KEYS[1])
if type(raw_watermark) == "table" and raw_watermark.err then
  if not string.match(raw_watermark.err, "^WRONGTYPE ") then return raw_watermark end
  raw_watermark = false
end
local current_watermark = 0
if raw_watermark then
  local parsed_watermark = parse_safe_integer(raw_watermark)
  if parsed_watermark then current_watermark = parsed_watermark end
end
local watermark = math.max(current_watermark, proposed_watermark)
local current_ttl_ms = -2
if raw_watermark then current_ttl_ms = redis.call("PTTL", KEYS[1]) end
local desired_ttl_ms = math.max(7200000, watermark - invalidated_at_ms + 3600000 + 60000)
if current_ttl_ms > desired_ttl_ms then desired_ttl_ms = current_ttl_ms end
local encoded_watermark = string.format("%.0f", watermark)
if current_ttl_ms == -1 then
  redis.call("SET", KEYS[1], encoded_watermark)
else
  redis.call("SET", KEYS[1], encoded_watermark, "PX", desired_ttl_ms)
end
return 1`
