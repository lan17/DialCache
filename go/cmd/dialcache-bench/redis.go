package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	dialcache "github.com/lan17/DialCache/go"
	"github.com/redis/go-redis/v9"
)

type countedRemote struct {
	*dialcache.RedisAdapter
	reads  atomic.Int64
	writes atomic.Int64
}

func (remote *countedRemote) Read(ctx context.Context, valueKey, watermarkKey string) (dialcache.ReadResult, error) {
	remote.reads.Add(1)
	return remote.RedisAdapter.Read(ctx, valueKey, watermarkKey)
}

func (remote *countedRemote) Write(ctx context.Context, key string, frame dialcache.Frame, ttl time.Duration) error {
	remote.writes.Add(1)
	return remote.RedisAdapter.Write(ctx, key, frame, ttl)
}

func commandStats(ctx context.Context, client *redis.Client) (redisCommands, error) {
	info, err := client.Info(ctx, "commandstats").Result()
	if err != nil {
		return redisCommands{}, err
	}
	var stats redisCommands
	targets := map[string]*int64{
		"get": &stats.Get, "mget": &stats.MGet, "set": &stats.Set,
		"eval": &stats.Eval, "evalsha": &stats.EvalSHA, "time": &stats.Time,
	}
	for _, line := range strings.Split(info, "\n") {
		name, details, found := strings.Cut(strings.TrimSpace(line), ":")
		if !found {
			continue
		}
		target := targets[strings.TrimPrefix(name, "cmdstat_")]
		if target == nil {
			continue
		}
		for _, field := range strings.Split(details, ",") {
			if raw, ok := strings.CutPrefix(field, "calls="); ok {
				value, err := strconv.ParseInt(raw, 10, 64)
				if err != nil {
					return stats, fmt.Errorf("parse Redis command stats: %w", err)
				}
				*target = value
			}
		}
	}
	return stats, nil
}

func commandDelta(after, before redisCommands) redisCommands {
	return redisCommands{
		Get: after.Get - before.Get, MGet: after.MGet - before.MGet,
		Set: after.Set - before.Set, Eval: after.Eval - before.Eval,
		EvalSHA: after.EvalSHA - before.EvalSHA, Time: after.Time - before.Time,
	}
}

func connectRedis(url string) (*redis.Client, error) {
	options, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	options.DialTimeout = 2 * time.Second
	options.ReadTimeout = 60 * time.Second
	options.WriteTimeout = 60 * time.Second
	options.MaxRetries = -1
	options.PoolSize = 1
	client := redis.NewClient(options)
	if err := client.Ping(context.Background()).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("connect to Redis: %w", err)
	}
	return client, nil
}

func runRedis(req request, iterations int, client *redis.Client, phase string) (r result, returnErr error) {
	r = newResult(req, iterations)
	ctx := context.Background()
	namespace := "benchmark-" + req.ID + "-" + phase
	identity := dialcache.Identity{
		Namespace: namespace, KeyType: "benchmark-key", ID: "shared", UseCase: "Benchmark",
		Tracked: req.Case.Kind == "redis-tracked-hit",
	}
	_, valueKey, watermarkKey, err := identity.Keys()
	if err != nil {
		return r, err
	}
	if req.Case.Kind == "redis-write" {
		valueKey = namespace + ":write"
	}
	cleanupKeys := []string{valueKey}
	if watermarkKey != "" {
		cleanupKeys = append(cleanupKeys, watermarkKey)
	}
	defer func() {
		if err := client.Del(ctx, cleanupKeys...).Err(); err != nil && returnErr == nil {
			returnErr = fmt.Errorf("clean up Redis keys: %w", err)
		}
	}()
	remote := &countedRemote{RedisAdapter: dialcache.NewRedisAdapter(client)}
	w, err := newWorkload(req, namespace, remote)
	if err != nil {
		return r, err
	}
	if req.Case.Kind != "redis-write" {
		value, err := w.scopedLookup("shared")
		if err != nil || value != req.Payload {
			return r, fmt.Errorf("prime Redis entry: value valid=%t, error=%v", value == req.Payload, err)
		}
	}
	w.sourceCalls.Store(0)
	remote.reads.Store(0)
	remote.writes.Store(0)
	values := make([]string, iterations)
	r.LatencyNS = make([]int64, iterations)
	payload := []byte(req.Payload)
	before, err := commandStats(ctx, client)
	if err != nil {
		return r, err
	}
	start := time.Now()
	for i := range iterations {
		operationStart := time.Now()
		if req.Case.Kind == "redis-write" {
			err = remote.Write(ctx, valueKey, dialcache.Frame{
				CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: payload, Binary: true,
			}, time.Hour)
			values[i] = req.Payload
		} else {
			values[i], err = w.scopedLookup("shared")
		}
		r.LatencyNS[i] = time.Since(operationStart).Nanoseconds()
		if err != nil {
			return r, err
		}
		r.Checksum += int64(len(values[i]))
	}
	r.ElapsedNS = time.Since(start).Nanoseconds()
	after, err := commandStats(ctx, client)
	if err != nil {
		return r, err
	}
	r.Counters = counters{SourceCalls: w.sourceCalls.Load(), RedisReads: remote.reads.Load(), RedisWrites: remote.writes.Load()}
	r.RedisCommands = commandDelta(after, before)
	r.ValueValid = validValues(values, req.Payload)
	if req.Case.Kind == "redis-write" {
		stored, err := remote.RedisAdapter.Read(ctx, valueKey, "")
		if err != nil {
			return r, fmt.Errorf("verify stored write: %w", err)
		}
		r.ValueValid = r.ValueValid && stored.Kind == "hit" && string(stored.Frame.Payload) == req.Payload && stored.Frame.Binary
		want := redisCommands{Set: int64(iterations)}
		if r.RedisCommands != want {
			return r, fmt.Errorf("Redis write commands = %+v, want %+v", r.RedisCommands, want)
		}
	}
	return r, nil
}
