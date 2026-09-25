package dialcache

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

type vectorInvalidationState struct {
	Kind   string   `json:"kind"`
	Value  string   `json:"value,omitempty"`
	Values []string `json:"values,omitempty"`
	TTLMS  int64    `json:"ttlMs"`
}
type vectorInvalidationInput struct {
	Existing        vectorInvalidationState `json:"existing"`
	FutureBufferMS  string                  `json:"futureBufferMs"`
	InvalidatedAtMS string                  `json:"invalidatedAtMs"`
}
type vectorInvalidationActual struct {
	Outcome   string `json:"outcome"`
	Kind      string `json:"kind"`
	Content   any    `json:"content"`
	TTLMS     int64  `json:"ttlMs"`
	ElapsedMS int64  `json:"elapsedMs"`
}

// Setup and observation bracket the actual production Lua in one atomic
// execution. The worker knows only inputs; no expected row enters this path.
const vectorInvalidationScript = `redis.replicate_commands()
local function now_ms()
 local now=redis.call("TIME")
 return tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)
end
local started_at=now_ms()
redis.call("DEL",KEYS[1])
if ARGV[3]=="string" then redis.call("SET",KEYS[1],ARGV[4]) end
if ARGV[3]=="list" then for _,value in ipairs(cjson.decode(ARGV[4])) do redis.call("RPUSH",KEYS[1],value) end end
if tonumber(ARGV[5])>0 then redis.call("PEXPIRE",KEYS[1],ARGV[5]) end
local result=(function()
` + InvalidationScript + `
end)()
local status=result==1 and "success" or (type(result)=="table" and (result.err=="ERR invalid DialCache future buffer" or result.err=="ERR invalid DialCache invalidatedAtMs") and "rejected" or "unexpected_reply")
local kind=redis.call("TYPE",KEYS[1]).ok
local content={}
if kind=="string" then content=redis.call("GET",KEYS[1]) end
if kind=="list" then content=redis.call("LRANGE",KEYS[1],0,-1) end
if kind=="none" then kind="absent" end
local ttl=redis.call("PTTL",KEYS[1])
return {status,kind,content,ttl,now_ms()-started_at}`

func vectorInvalidationClient(t *testing.T) (*redis.Client, string) {
	t.Helper()
	endpoint := os.Getenv("DIALCACHE_VECTOR_REDIS_URL")
	if endpoint == "" {
		t.Fatal("INVALIDATION_INFRASTRUCTURE: Redis vector endpoint required")
	}
	options, err := redis.ParseURL(endpoint)
	if err != nil {
		t.Fatal("INVALIDATION_INFRASTRUCTURE:", err)
	}
	options.MaxRetries = -1
	client := redis.NewClient(options)
	key := fmt.Sprintf("{formal-invalidation-%d-%d}#watermark", os.Getpid(), time.Now().UnixNano())
	t.Cleanup(func() { client.Del(context.Background(), key); client.Close() })
	return client, key
}
func recordVectorInvalidation(t *testing.T, client *redis.Client, key string, input vectorInvalidationInput) vectorInvalidationActual {
	t.Helper()
	content := input.Existing.Value
	if input.Existing.Kind == "list" {
		encoded, err := json.Marshal(input.Existing.Values)
		if err != nil {
			t.Fatal("INVALIDATION_INFRASTRUCTURE:", err)
		}
		content = string(encoded)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	raw, err := client.Eval(ctx, vectorInvalidationScript, []string{key}, input.FutureBufferMS, input.InvalidatedAtMS, input.Existing.Kind, content, input.Existing.TTLMS).Slice()
	if err != nil || len(raw) != 5 {
		t.Fatal("INVALIDATION_INFRASTRUCTURE: invalid native reply", raw, err)
	}
	outcome, ok1 := raw[0].(string)
	kind, ok2 := raw[1].(string)
	ttl, ok3 := raw[3].(int64)
	elapsed, ok4 := raw[4].(int64)
	if !ok1 || !ok2 || !ok3 || !ok4 || (outcome != "success" && outcome != "rejected") || ttl < -2 || elapsed < 0 {
		t.Fatal("INVALIDATION_INFRASTRUCTURE: malformed native result", raw)
	}
	switch kind {
	case "string":
		if _, ok := raw[2].(string); !ok {
			t.Fatal("INVALIDATION_INFRASTRUCTURE: malformed string", raw)
		}
	case "list", "absent":
		items, ok := raw[2].([]any)
		if !ok || (kind == "absent" && len(items) != 0) || (kind == "list" && len(items) == 0) {
			t.Fatal("INVALIDATION_INFRASTRUCTURE: malformed content", raw)
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				t.Fatal("INVALIDATION_INFRASTRUCTURE: malformed list", raw)
			}
		}
	default:
		t.Fatal("INVALIDATION_INFRASTRUCTURE: unexpected key type", kind)
	}
	return vectorInvalidationActual{Outcome: outcome, Kind: kind, Content: raw[2], TTLMS: ttl, ElapsedMS: elapsed}
}

// One connection replays the complete generated set. Process/transport errors
// are explicitly rejected by the campaign evaluator as infrastructure.
func TestGeneratedInvalidationVectors(t *testing.T) {
	if os.Getenv("DIALCACHE_VECTOR_REDIS_URL") == "" {
		t.Skip("this native vector lane runs in mutation campaigns")
	}
	raw, err := os.ReadFile("../../../formal/quint-invalidation-vectors.json")
	if err != nil {
		t.Fatal("INVALIDATION_INFRASTRUCTURE:", err)
	}
	var corpus struct {
		SchemaVersion int `json:"schemaVersion"`
		Provenance    struct {
			Model        string
			SourceSHA256 map[string]string `json:"sourceSha256"`
		}
		Vectors []struct {
			Name string
			vectorInvalidationInput
			Expected struct {
				Error bool
				State vectorInvalidationState
			}
		}
	}
	if err = json.Unmarshal(raw, &corpus); err != nil || corpus.SchemaVersion != 2 || len(corpus.Vectors) != 288 {
		t.Fatal("INVALIDATION_INFRASTRUCTURE: invalid corpus", err)
	}
	const model = "formal/dialcache-invalidation-transition.qnt"
	if corpus.Provenance.Model != model || len(corpus.Provenance.SourceSHA256) != 2 {
		t.Fatal("INVALIDATION_INFRASTRUCTURE: invalid provenance")
	}
	for _, path := range []string{model, "formal/generate-invalidation-vectors.mjs"} {
		source, err := os.ReadFile(filepath.Join("../../..", path))
		if err != nil || fmt.Sprintf("%x", sha256.Sum256(source)) != corpus.Provenance.SourceSHA256[path] {
			t.Fatal("INVALIDATION_INFRASTRUCTURE: stale provenance", path, err)
		}
	}
	client, key := vectorInvalidationClient(t)
	for i, row := range corpus.Vectors {
		if !strings.HasPrefix(row.Name, fmt.Sprintf("Quint %03d: ", i)) {
			t.Fatal("INVALIDATION_INFRASTRUCTURE: incomplete or reordered vectors")
		}
		t.Run(row.Name, func(t *testing.T) {
			actual := recordVectorInvalidation(t, client, key, row.vectorInvalidationInput)
			outcome := "success"
			if row.Expected.Error {
				outcome = "rejected"
			}
			state := row.Expected.State
			var content any = state.Value
			if state.Kind != "string" {
				items := make([]any, len(state.Values))
				for i, v := range state.Values {
					items[i] = v
				}
				content = items
			}
			if actual.Outcome != outcome || actual.Kind != state.Kind || !reflect.DeepEqual(actual.Content, content) {
				t.Errorf("invalidation result: got=%+v want outcome=%s kind=%s content=%v", actual, outcome, state.Kind, content)
			}
			if state.TTLMS < 0 {
				if actual.TTLMS != state.TTLMS {
					t.Errorf("TTL %d want %d", actual.TTLMS, state.TTLMS)
				}
			} else {
				minimum := max(int64(0), state.TTLMS-actual.ElapsedMS)
				if actual.TTLMS < minimum || actual.TTLMS > state.TTLMS {
					t.Errorf("TTL %d outside [%d,%d] with server elapsed %d", actual.TTLMS, minimum, state.TTLMS, actual.ElapsedMS)
				}
			}
		})
	}
}
