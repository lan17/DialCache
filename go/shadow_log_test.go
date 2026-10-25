package dialcache

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// mismatchPathVector is one row of the mismatchPathVectors group in
// formal/catalogs/protocol-vectors.json: the built-in walk's hand-authored
// expectations, which every port replays and which the documented examples in
// docs/shadow-validation.md come from.
type mismatchPathVector struct {
	Name           string          `json:"name"`
	Cached, Source json.RawMessage // nil when the row omits the side
	Entries        []any           `json:"entries"`
	Count          int             `json:"count"`
}

// sharedMismatchPathVectors reads the group whatever DIALCACHE_PROTOCOL_CORPUS
// selects, so the ordinary suite pins the walk as the protocol suite does.
func sharedMismatchPathVectors(t *testing.T) []mismatchPathVector {
	t.Helper()
	raw, err := os.ReadFile("../formal/catalogs/protocol-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Vectors []mismatchPathVector `json:"mismatchPathVectors"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Vectors) == 0 {
		t.Fatal("protocol-vectors.json has no mismatchPathVectors")
	}
	return corpus.Vectors
}

// mismatchVectorSide is a vector side as the warning receives it: Absent when
// the row omits it (D13), else its parsed JSON.
func mismatchVectorSide(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	if raw == nil {
		return Absent
	}
	return parseJSONValue(t, string(raw))
}

func parseJSONValue(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// boundedEntries renders walk entries with the diffJson clamp rule, unclamped
// as a whole, and parses them back for comparison as JSON.
func boundedEntries(t *testing.T, entries []MismatchEntry) []any {
	t.Helper()
	encoded, rendered := appendMismatchEntries(nil, entries)
	if !rendered {
		t.Fatal("walk entries have no rendering")
	}
	parsed, _ := parseJSONValue(t, string(encoded)).([]any)
	return parsed
}

func entryPaths(entries []any) []string {
	paths := []string{}
	for _, entry := range entries {
		paths = append(paths, entry.(map[string]any)["path"].(string))
	}
	return paths
}

func renderMismatch(value bool, diff MismatchDiffLevel, cached, source any) (map[string]any, string) {
	return renderShadowMismatchLog(value, diff, cached, source, nil)
}

func expectLog(t *testing.T, fields map[string]any, failure string, wantFields map[string]any, wantFailure string) {
	t.Helper()
	if failure != wantFailure || !reflect.DeepEqual(fields, wantFields) {
		t.Fatalf("rendered %#v with failure %q, want %#v with %q", fields, failure, wantFields, wantFailure)
	}
}

func nestMembers(depth int, leaf any) any {
	value := leaf
	for level := 0; level < depth; level++ {
		value = map[string]any{"n": value}
	}
	return value
}

// An absent side reaches the walk only through rendering, as Absent.
func TestBuiltInMismatchPathVectors(t *testing.T) {
	for _, vector := range sharedMismatchPathVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			cached, source := mismatchVectorSide(t, vector.Cached), mismatchVectorSide(t, vector.Source)
			if !IsAbsent(cached) && !IsAbsent(source) {
				entries, count := walkJSON(cached, source)
				if count != vector.Count || !reflect.DeepEqual(boundedEntries(t, entries), append([]any{}, vector.Entries...)) {
					t.Fatalf("walk: %d %#v, want %d %#v", count, boundedEntries(t, entries), vector.Count, vector.Entries)
				}
			}
			fields, failure := renderMismatch(false, MismatchDiffValues, cached, source)
			diffJSON, _ := fields["diffJson"].(string)
			if failure != "" || fields["mismatchPathCount"] != vector.Count || !reflect.DeepEqual(fields["mismatchPaths"], entryPaths(vector.Entries)) || !reflect.DeepEqual(parseJSONValue(t, diffJSON), append([]any{}, vector.Entries...)) {
				t.Fatalf("diff values fields: %#v %q", fields, failure)
			}
			paths, failure := renderMismatch(false, MismatchDiffPaths, cached, source)
			expectLog(t, paths, failure, map[string]any{"mismatchPaths": fields["mismatchPaths"], "mismatchPathCount": vector.Count}, "")
		})
	}
}

func TestBuiltInMismatchWalkReadsOwnMembersOnly(t *testing.T) {
	// Names that are prototype members in JavaScript are ordinary members.
	cached := parseJSONValue(t, `{"constructor":1,"__proto__":{"a":1}}`)
	source := parseJSONValue(t, `{"toString":"x","valueOf":null,"__proto__":{"a":2}}`)
	want := parseJSONValue(t, `[{"path":"/__proto__/a","cached":1,"source":2},{"path":"/constructor","cached":1},{"path":"/toString","source":"x"},{"path":"/valueOf","source":null}]`)
	entries, count := walkJSON(cached, source)
	if count != 4 || !reflect.DeepEqual(boundedEntries(t, entries), want) {
		t.Fatalf("own-member walk: %d %#v", count, boundedEntries(t, entries))
	}
	nest := func(leaf string) any {
		return parseJSONValue(t, strings.Repeat(`{"a":`, 32)+leaf+strings.Repeat("}", 32))
	}
	entries, count = walkJSON(nest(`{"__proto__":{}}`), nest(`{"b":{}}`))
	want = parseJSONValue(t, `[{"path":"`+strings.Repeat("/a", 32)+`","cached":{"__proto__":{}},"source":{"b":{}}}]`)
	if count != 1 || !reflect.DeepEqual(boundedEntries(t, entries), want) {
		t.Fatalf("depth-capped own members: %d %#v", count, boundedEntries(t, entries))
	}
}

func TestBuiltInMismatchWalkCaps(t *testing.T) {
	t.Run("entries cut at 64 with the uncut count", func(t *testing.T) {
		cached, source := map[string]any{}, map[string]any{}
		paths := []string{}
		for index := 69; index >= 0; index-- {
			name := fmt.Sprintf("m%02d", index)
			cached[name], source[name] = 0.0, 1.0
		}
		for index := 0; index < 64; index++ {
			paths = append(paths, fmt.Sprintf("/m%02d", index))
		}
		entries, count := walkJSON(cached, source)
		if count != 70 || len(entries) != 64 || entries[63].Path != "/m63" {
			t.Fatalf("cut: %d entries, count %d", len(entries), count)
		}
		fields, failure := renderMismatch(false, MismatchDiffPaths, cached, source)
		expectLog(t, fields, failure, map[string]any{"mismatchPaths": paths, "mismatchPathCount": 70}, "")
	})
	t.Run("pointers clamped to 512 bytes on a UTF-8 boundary", func(t *testing.T) {
		names := []string{strings.Repeat("k", 511), strings.Repeat("k", 600), strings.Repeat("é", 300)}
		cached, source := map[string]any{}, map[string]any{}
		for _, name := range names {
			cached[name], source[name] = 1.0, 2.0
		}
		fields, failure := renderMismatch(false, MismatchDiffValues, cached, source)
		wantPaths := []string{"/" + names[0], "/" + strings.Repeat("k", 497) + ShadowLogTruncationMarker, "/" + strings.Repeat("é", 248) + ShadowLogTruncationMarker}
		if failure != "" || !reflect.DeepEqual(fields["mismatchPaths"], wantPaths) || len(wantPaths[1]) != 512 {
			t.Fatalf("pointer clamp: %#v", fields["mismatchPaths"])
		}
		if entries := entryPaths(parseJSONValue(t, fields["diffJson"].(string)).([]any)); !reflect.DeepEqual(entries, wantPaths) {
			t.Fatalf("diffJson pointer clamp: %#v", entries)
		}
	})
	t.Run("each side over 1 KiB replaced by its clamped JSON text", func(t *testing.T) {
		list := make([]any, 300)
		for index := range list {
			list[index] = 1000.0
		}
		cached := map[string]any{"accent": strings.Repeat("é", 600), "blob": strings.Repeat("x", 2000), "edge": strings.Repeat("e", 1022), "extra": strings.Repeat("z", 1100), "list": list}
		source := map[string]any{"accent": "a", "blob": "y", "edge": strings.Repeat("f", 1022), "list": []any{1000.0}}
		listJSON, _ := json.Marshal(list)
		want := []any{
			map[string]any{"path": "/accent", "cached": `"` + strings.Repeat("é", 504) + ShadowLogTruncationMarker, "source": "a"},
			map[string]any{"path": "/blob", "cached": `"` + strings.Repeat("x", 1009) + ShadowLogTruncationMarker, "source": "y"},
			map[string]any{"path": "/edge", "cached": strings.Repeat("e", 1022), "source": strings.Repeat("f", 1022)},
			map[string]any{"path": "/extra", "cached": `"` + strings.Repeat("z", 1009) + ShadowLogTruncationMarker},
			map[string]any{"path": "/list", "cached": string(listJSON[:1010]) + ShadowLogTruncationMarker, "source": []any{1000.0}},
		}
		entries, count := walkJSON(cached, source)
		if count != 5 || !reflect.DeepEqual(boundedEntries(t, entries), want) {
			t.Fatalf("side clamp: %#v", boundedEntries(t, entries))
		}
	})
	t.Run("the walk stops at 32 reference tokens", func(t *testing.T) {
		entries, count := walkJSON(nestMembers(40, 1.0), nestMembers(40, 2.0))
		want := []any{map[string]any{"path": strings.Repeat("/n", 32), "cached": nestMembers(8, 1.0), "source": nestMembers(8, 2.0)}}
		if count != 1 || !reflect.DeepEqual(boundedEntries(t, entries), want) {
			t.Fatalf("depth cap: %#v", boundedEntries(t, entries))
		}
		clamped := strings.Repeat(`{"n":`, 202) + ShadowLogTruncationMarker
		entries, count = walkJSON(nestMembers(1000, 1.0), nestMembers(1000, 2.0))
		want = []any{map[string]any{"path": strings.Repeat("/n", 32), "cached": clamped, "source": clamped}}
		if count != 1 || !reflect.DeepEqual(boundedEntries(t, entries), want) {
			t.Fatalf("deep depth cap: %#v", boundedEntries(t, entries))
		}
	})
	t.Run("equal containers past the cap compare structurally at any depth", func(t *testing.T) {
		var cached, source any = "leaf", "leaf"
		for level := 0; level < 100_000; level++ {
			cached = map[string]any{"a": float64(level), "next": cached}
			source = map[string]any{"next": source, "a": float64(level)}
		}
		if entries, count := walkJSON(cached, source); count != 0 || len(entries) != 0 {
			t.Fatalf("equal deep containers reported %d entries", count)
		}
	})
}

func TestBuiltInMismatchWalkBuildsOnlyRetainedPointers(t *testing.T) {
	// A chain of member names above a wide object and a long array makes every
	// pointer below it long. Half their members and elements are equal, and all
	// but 64 of the differing ones fall past the cut. Lengthening the names must
	// cost only the retained pointers, never a copy of the prefix per visited
	// member or element, which would take over a gigabyte here.
	walk := func(nameBytes int) (allocated uint64, prefixBytes int) {
		name := strings.Repeat("k", nameBytes)
		side := func(differing float64) any {
			members, items := map[string]any{}, make([]any, 5_000)
			for index := range items {
				value := float64(index%2) * differing
				members[fmt.Sprintf("m%04d", index)], items[index] = value, value
			}
			var value any = map[string]any{"items": items, "members": members}
			for level := 0; level < 30; level++ {
				value = map[string]any{name: value}
			}
			return value
		}
		cached, source := side(1), side(2)
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		entries, count := walkJSON(cached, source)
		runtime.ReadMemStats(&after)
		prefix := strings.Repeat("/"+name, 30)
		if count != 5_000 || len(entries) != shadowMismatchMaxEntries || entries[0].Path != prefix+"/items/1" || entries[63].Path != prefix+"/items/127" {
			t.Fatalf("walk under %d-byte names: %d entries, count %d", nameBytes, len(entries), count)
		}
		return after.TotalAlloc - before.TotalAlloc, len(prefix)
	}
	shortAllocated, shortPrefix := walk(1)
	longAllocated, longPrefix := walk(4096)
	retained := uint64(shadowMismatchMaxEntries * (longPrefix - shortPrefix))
	if longAllocated > shortAllocated+2*retained {
		t.Fatalf("lengthening the pointers by %d bytes allocated %d more bytes, want at most %d", longPrefix-shortPrefix, longAllocated-shortAllocated, 2*retained)
	}
}

var (
	cachedUser     = map[string]any{"id": "123", "email": "old@example.com"}
	sourceUser     = map[string]any{"id": "123", "email": "new@example.com"}
	cachedUserJSON = `{"email":"old@example.com","id":"123"}`
	sourceUserJSON = `{"email":"new@example.com","id":"123"}`
	failedDiff     = map[string]any{"mismatchPaths": nil, "mismatchPathCount": nil, "diffJson": nil}
)

func withFields(base map[string]any, extra map[string]any) map[string]any {
	merged := map[string]any{}
	for name, value := range base {
		merged[name] = value
	}
	for name, value := range extra {
		merged[name] = value
	}
	return merged
}

type failingJSON struct{}

func (failingJSON) MarshalJSON() ([]byte, error) { return nil, errors.New("not serializable") }

type panickingJSON struct{}

func (panickingJSON) MarshalJSON() ([]byte, error) { panic("not serializable") }

// countingJSON counts its renderings and reports the count in each one.
type countingJSON struct {
	email   string
	renders *int
}

func (value countingJSON) MarshalJSON() ([]byte, error) {
	*value.renders++
	return json.Marshal(map[string]any{"email": value.email, "render": *value.renders})
}

func TestShadowMismatchLogFieldsPerLeaves(t *testing.T) {
	paths := map[string]any{"mismatchPaths": []string{"/email"}, "mismatchPathCount": 1}
	diffJSON := `[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]`
	values := map[string]any{"cachedValueJson": cachedUserJSON, "sourceValueJson": sourceUserJSON}
	for _, test := range []struct {
		name   string
		value  bool
		diff   MismatchDiffLevel
		fields map[string]any
	}{
		{"neither leaf", false, MismatchDiffOff, map[string]any{}},
		{"diff paths only", false, MismatchDiffPaths, paths},
		{"diff values without value", false, MismatchDiffValues, withFields(paths, map[string]any{"diffJson": diffJSON})},
		{"value only", true, MismatchDiffOff, values},
		{"value with diff paths", true, MismatchDiffPaths, withFields(paths, values)},
		{"value with diff values", true, MismatchDiffValues, withFields(withFields(paths, values), map[string]any{"diffJson": diffJSON})},
	} {
		t.Run(test.name, func(t *testing.T) {
			fields, failure := renderMismatch(test.value, test.diff, cachedUser, sourceUser)
			expectLog(t, fields, failure, test.fields, "")
		})
	}
}

func TestShadowMismatchLogRendersEachRootOnce(t *testing.T) {
	var cachedRenders, sourceRenders int
	fields, failure := renderMismatch(true, MismatchDiffValues, countingJSON{"a", &cachedRenders}, countingJSON{"b", &sourceRenders})
	expectLog(t, fields, failure, map[string]any{
		"mismatchPaths":     []string{"/email"},
		"mismatchPathCount": 1,
		"diffJson":          `[{"path":"/email","cached":"a","source":"b"}]`,
		"cachedValueJson":   `{"email":"a","render":1}`,
		"sourceValueJson":   `{"email":"b","render":1}`,
	}, "")
	if cachedRenders != 1 || sourceRenders != 1 {
		t.Fatalf("roots rendered %d and %d times", cachedRenders, sourceRenders)
	}
}

func TestShadowMismatchLogNoEntriesForIdenticalRenderings(t *testing.T) {
	noEntries := map[string]any{"mismatchPaths": []string{}, "mismatchPathCount": 0, "diffJson": "[]"}
	// The default comparator tells an Absent member from a missing one, but
	// neither renders.
	fields, failure := renderMismatch(true, MismatchDiffValues, map[string]any{"id": 1, "dropped": Absent}, map[string]any{"id": 1})
	expectLog(t, fields, failure, withFields(noEntries, map[string]any{"cachedValueJson": `{"id":1}`, "sourceValueJson": `{"id":1}`}), "")
	// A time.Time renders as the ISO string the JSON codec stored.
	at := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	fields, failure = renderMismatch(false, MismatchDiffValues, map[string]any{"at": "2026-10-24T00:00:00Z"}, map[string]any{"at": at})
	expectLog(t, fields, failure, noEntries, "")
}

func TestShadowMismatchLogAbsentRootIsASide(t *testing.T) {
	version := map[string]any{"version": 2}
	fields, failure := renderMismatch(true, MismatchDiffValues, Absent, version)
	expectLog(t, fields, failure, map[string]any{
		"mismatchPaths": []string{""}, "mismatchPathCount": 1, "diffJson": `[{"path":"","source":{"version":2}}]`,
		"cachedValueJson": nil, "sourceValueJson": `{"version":2}`,
	}, "")
	fields, failure = renderMismatch(true, MismatchDiffValues, version, Absent)
	expectLog(t, fields, failure, map[string]any{
		"mismatchPaths": []string{""}, "mismatchPathCount": 1, "diffJson": `[{"path":"","cached":{"version":2}}]`,
		"cachedValueJson": `{"version":2}`, "sourceValueJson": nil,
	}, "")
	fields, failure = renderMismatch(false, MismatchDiffPaths, Absent, nil)
	expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{""}, "mismatchPathCount": 1}, "")
	// A stored null is a value, so it stays distinct from absence.
	if fields, _ := renderMismatch(false, MismatchDiffValues, Absent, nil); fields["diffJson"] != `[{"path":"","source":null}]` {
		t.Fatalf("absent against null: %#v", fields["diffJson"])
	}
	// Absence beside a root with no rendering is still a render failure.
	fields, failure = renderMismatch(true, MismatchDiffValues, Absent, big.NewInt(1))
	expectLog(t, fields, failure, withFields(failedDiff, map[string]any{"cachedValueJson": nil, "sourceValueJson": nil}), "render_error")
	// A custom comparator may call two absent values different; no field differs.
	fields, failure = renderMismatch(true, MismatchDiffValues, Absent, Absent)
	expectLog(t, fields, failure, map[string]any{
		"mismatchPaths": []string{}, "mismatchPathCount": 0, "diffJson": "[]", "cachedValueJson": nil, "sourceValueJson": nil,
	}, "")
}

func TestShadowMismatchLogRootRenderFailures(t *testing.T) {
	cycle := map[string]any{}
	cycle["self"] = cycle
	for _, test := range []struct {
		name         string
		unrenderable any
	}{
		{"cycle", cycle}, {"big integer", big.NewInt(1)}, {"failing MarshalJSON", failingJSON{}},
		{"panicking MarshalJSON", panickingJSON{}}, {"function", func() {}}, {"channel", make(chan int)}, {"complex number", complex(1, 2)},
	} {
		t.Run(test.name, func(t *testing.T) {
			fields, failure := renderMismatch(true, MismatchDiffValues, test.unrenderable, map[string]any{"version": 2})
			expectLog(t, fields, failure, withFields(failedDiff, map[string]any{"cachedValueJson": nil, "sourceValueJson": `{"version":2}`}), "render_error")
			fields, failure = renderMismatch(true, MismatchDiffValues, map[string]any{"version": 2}, test.unrenderable)
			expectLog(t, fields, failure, withFields(failedDiff, map[string]any{"cachedValueJson": `{"version":2}`, "sourceValueJson": nil}), "render_error")
			fields, failure = renderMismatch(false, MismatchDiffPaths, map[string]any{"version": 2}, test.unrenderable)
			expectLog(t, fields, failure, map[string]any{"mismatchPaths": nil, "mismatchPathCount": nil}, "render_error")
		})
	}
}

func TestShadowMismatchLogClampsDiffJSON(t *testing.T) {
	cached, source := map[string]any{}, map[string]any{}
	paths := []string{}
	var entries strings.Builder
	entries.WriteString("[")
	for index := 0; index < 20; index++ {
		name := fmt.Sprintf("m%02d", index)
		cached[name], source[name] = strings.Repeat("x", 500), strings.Repeat("y", 500)
		paths = append(paths, "/"+name)
		if index > 0 {
			entries.WriteString(",")
		}
		fmt.Fprintf(&entries, `{"path":"/%s","cached":"%s","source":"%s"}`, name, strings.Repeat("x", 500), strings.Repeat("y", 500))
	}
	// The 8 KiB bound is the record's, so it is written out rather than taken
	// from the implementation's constant.
	diffJSON := entries.String()[:8192-len(ShadowLogTruncationMarker)] + ShadowLogTruncationMarker
	fields, failure := renderMismatch(false, MismatchDiffValues, cached, source)
	expectLog(t, fields, failure, map[string]any{"mismatchPaths": paths, "mismatchPathCount": 20, "diffJson": diffJSON}, "")
	if len(diffJSON) != 8192 {
		t.Fatalf("diffJson bytes: %d", len(diffJSON))
	}
	fields, _ = renderMismatch(false, MismatchDiffValues, map[string]any{"blob": strings.Repeat("x", 2000)}, map[string]any{"blob": "y"})
	want := parseJSONValue(t, `[{"path":"/blob","cached":"\"`+strings.Repeat("x", 1009)+ShadowLogTruncationMarker+`","source":"y"}]`)
	if !reflect.DeepEqual(parseJSONValue(t, fields["diffJson"].(string)), want) {
		t.Fatalf("built-in side clamp: %v", fields["diffJson"])
	}
}

func TestShadowMismatchLogWalkFailureIsHookError(t *testing.T) {
	// A rendering nested past encoding/json's 10,000-level limit does not
	// parse back, so the built-in walk fails closed as a hook would.
	var deep any = 1.0
	for level := 0; level < 10_001; level++ {
		deep = []any{deep}
	}
	fields, failure := renderMismatch(false, MismatchDiffPaths, deep, 2.0)
	expectLog(t, fields, failure, map[string]any{"mismatchPaths": nil, "mismatchPathCount": nil}, "hook_error")
	fields, failure = renderMismatch(true, MismatchDiffValues, cachedUser, deep)
	if failure != "hook_error" || fields["mismatchPaths"] != nil || fields["diffJson"] != nil || fields["cachedValueJson"] != cachedUserJSON || !strings.HasSuffix(fields["sourceValueJson"].(string), ShadowLogTruncationMarker) {
		t.Fatalf("walk failure: %#v %q", fields, failure)
	}
}

func hookReturning(entries []MismatchEntry, err error) (func() ([]MismatchEntry, error), *int) {
	calls := 0
	return func() ([]MismatchEntry, error) { calls++; return entries, err }, &calls
}

func TestShadowMismatchDiffHook(t *testing.T) {
	t.Run("replaces the built-in walk", func(t *testing.T) {
		hook, calls := hookReturning([]MismatchEntry{
			{Path: "/profile/email", Cached: "old@example.com", Source: "new@example.com"},
			{Path: "/roles", Cached: Absent, Source: Absent},
		}, nil)
		fields, failure := renderShadowMismatchLog(true, MismatchDiffValues, map[string]any{"id": 1}, map[string]any{"id": 2}, hook)
		expectLog(t, fields, failure, map[string]any{
			"mismatchPaths":     []string{"/profile/email", "/roles"},
			"mismatchPathCount": 2,
			"diffJson":          `[{"path":"/profile/email","cached":"old@example.com","source":"new@example.com"},{"path":"/roles"}]`,
			"cachedValueJson":   `{"id":1}`,
			"sourceValueJson":   `{"id":2}`,
		}, "")
		if *calls != 1 {
			t.Fatalf("hook calls: %d", *calls)
		}
	})
	t.Run("renders neither root when value is off", func(t *testing.T) {
		var cachedRenders, sourceRenders int
		hook, _ := hookReturning([]MismatchEntry{}, nil)
		fields, failure := renderShadowMismatchLog(false, MismatchDiffValues, countingJSON{"a", &cachedRenders}, countingJSON{"b", &sourceRenders}, hook)
		expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{}, "mismatchPathCount": 0, "diffJson": "[]"}, "")
		if cachedRenders != 0 || sourceRenders != 0 {
			t.Fatal("a hook-supplied diff rendered a root")
		}
	})
	t.Run("a nil slice is an empty list", func(t *testing.T) {
		hook, _ := hookReturning(nil, nil)
		fields, failure := renderShadowMismatchLog(false, MismatchDiffValues, cachedUser, sourceUser, hook)
		expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{}, "mismatchPathCount": 0, "diffJson": "[]"}, "")
	})
	for _, test := range []struct {
		name string
		hook func() ([]MismatchEntry, error)
	}{
		{"returns an error", func() ([]MismatchEntry, error) { return []MismatchEntry{{Path: "/email"}}, errors.New("hook failed") }},
		{"panics", func() ([]MismatchEntry, error) { panic("hook failed") }},
		{"panics with nil", func() ([]MismatchEntry, error) { panic(nil) }},
	} {
		t.Run("fails closed with no fallback when the hook "+test.name, func(t *testing.T) {
			fields, failure := renderShadowMismatchLog(true, MismatchDiffValues, cachedUser, sourceUser, test.hook)
			expectLog(t, fields, failure, withFields(failedDiff, map[string]any{"cachedValueJson": cachedUserJSON, "sourceValueJson": sourceUserJSON}), "hook_error")
			fields, failure = renderShadowMismatchLog(false, MismatchDiffPaths, cachedUser, sourceUser, test.hook)
			expectLog(t, fields, failure, map[string]any{"mismatchPaths": nil, "mismatchPathCount": nil}, "hook_error")
		})
	}
	cycle := map[string]any{}
	cycle["self"] = cycle
	for _, test := range []struct {
		name         string
		unrenderable any
	}{{"a big integer", big.NewInt(1)}, {"a cycle", cycle}, {"a function", func() {}}, {"a failing MarshalJSON", failingJSON{}}} {
		t.Run("keeps the paths and nulls diffJson when a side is "+test.name, func(t *testing.T) {
			hook, _ := hookReturning([]MismatchEntry{{Path: "/a", Cached: 1, Source: Absent}, {Path: "/b", Cached: Absent, Source: test.unrenderable}}, nil)
			fields, failure := renderShadowMismatchLog(false, MismatchDiffValues, cachedUser, sourceUser, hook)
			expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{"/a", "/b"}, "mismatchPathCount": 2, "diffJson": nil}, "render_error")
			fields, failure = renderShadowMismatchLog(false, MismatchDiffPaths, cachedUser, sourceUser, hook)
			expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{"/a", "/b"}, "mismatchPathCount": 2}, "")
		})
	}
	t.Run("stops rendering sides at the first with no rendering", func(t *testing.T) {
		renders := 0
		hook, _ := hookReturning([]MismatchEntry{{Path: "/a", Cached: big.NewInt(1), Source: Absent}, {Path: "/b", Cached: Absent, Source: countingJSON{"later", &renders}}}, nil)
		fields, failure := renderShadowMismatchLog(false, MismatchDiffValues, cachedUser, sourceUser, hook)
		expectLog(t, fields, failure, map[string]any{"mismatchPaths": []string{"/a", "/b"}, "mismatchPathCount": 2, "diffJson": nil}, "render_error")
		if renders != 0 {
			t.Fatal("rendered a side after the first failure")
		}
	})
	t.Run("omits Absent sides and renders the rest as JSON", func(t *testing.T) {
		hook, _ := hookReturning([]MismatchEntry{
			{Path: "/a", Cached: Absent, Source: Absent},
			{Path: "/b", Cached: 1, Source: Absent},
			{Path: "/c", Cached: Absent, Source: nil},
			{Path: "/at", Cached: time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC), Source: map[string]any{"ok": true}},
		}, nil)
		fields, _ := renderShadowMismatchLog(false, MismatchDiffValues, cachedUser, sourceUser, hook)
		if want := `[{"path":"/a"},{"path":"/b","cached":1},{"path":"/c","source":null},{"path":"/at","cached":"2026-07-31T00:00:00Z","source":{"ok":true}}]`; fields["diffJson"] != want {
			t.Fatalf("hook sides: %v", fields["diffJson"])
		}
	})
	t.Run("clamps paths and sides and cuts at 64 with the total count", func(t *testing.T) {
		clampedPath := "/" + strings.Repeat("k", 497) + ShadowLogTruncationMarker
		entries := []MismatchEntry{{Path: "/" + strings.Repeat("k", 600), Cached: strings.Repeat("x", 2000), Source: map[string]any{"ok": true}}}
		retained := []string{clampedPath}
		wantEntries := []any{map[string]any{"path": clampedPath, "cached": `"` + strings.Repeat("x", 1009) + ShadowLogTruncationMarker, "source": map[string]any{"ok": true}}}
		for index := 1; index <= 69; index++ {
			path := fmt.Sprintf("/%d", index)
			entries = append(entries, MismatchEntry{Path: path, Cached: Absent, Source: Absent})
			if index < 64 {
				retained = append(retained, path)
				wantEntries = append(wantEntries, map[string]any{"path": path})
			}
		}
		hook, _ := hookReturning(entries, nil)
		fields, failure := renderShadowMismatchLog(false, MismatchDiffValues, cachedUser, sourceUser, hook)
		if failure != "" || fields["mismatchPathCount"] != 70 || !reflect.DeepEqual(fields["mismatchPaths"], retained) || !reflect.DeepEqual(parseJSONValue(t, fields["diffJson"].(string)), wantEntries) {
			t.Fatalf("hook clamps: %#v", fields)
		}
	})
	t.Run("is not called when diff is off", func(t *testing.T) {
		hook, calls := hookReturning([]MismatchEntry{{Path: "/email"}}, nil)
		fields, failure := renderShadowMismatchLog(true, MismatchDiffOff, cachedUser, sourceUser, hook)
		expectLog(t, fields, failure, map[string]any{"cachedValueJson": cachedUserJSON, "sourceValueJson": sourceUserJSON}, "")
		if *calls != 0 {
			t.Fatal("hook ran with diff off")
		}
	})
	t.Run("keeps the entries when a root has no rendering", func(t *testing.T) {
		hook, _ := hookReturning([]MismatchEntry{{Path: "/a", Cached: Absent, Source: Absent}}, nil)
		fields, failure := renderShadowMismatchLog(true, MismatchDiffValues, big.NewInt(1), sourceUser, hook)
		expectLog(t, fields, failure, map[string]any{
			"mismatchPaths": []string{"/a"}, "mismatchPathCount": 1, "diffJson": `[{"path":"/a"}]`,
			"cachedValueJson": nil, "sourceValueJson": sourceUserJSON,
		}, "render_error")
	})
	t.Run("reports hook_error ahead of render_error", func(t *testing.T) {
		hook, _ := hookReturning(nil, errors.New("hook failed"))
		fields, failure := renderShadowMismatchLog(true, MismatchDiffValues, cycle, sourceUser, hook)
		expectLog(t, fields, failure, withFields(failedDiff, map[string]any{"cachedValueJson": nil, "sourceValueJson": sourceUserJSON}), "hook_error")
	})
}
