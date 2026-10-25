package dialcache

import (
	"bytes"
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// Bounds of the confirmed-mismatch difference fields.
const (
	shadowLogDiffMaxBytes      = 8192
	shadowMismatchMaxEntries   = 64
	shadowMismatchPathMaxBytes = 512
	shadowMismatchSideMaxBytes = 1024
	// shadowMismatchMaxDepth counts the reference tokens in the deepest pointer
	// the built-in walk reports.
	shadowMismatchMaxDepth = 32
)

// Why warning construction failed: the difference computation (hook or
// built-in walk) ranks above JSON rendering.
const (
	shadowLogHookError   = "hook_error"
	shadowLogRenderError = "render_error"
)

// renderShadowMismatchLog builds the content fields the effective leaves
// request for one confirmed mismatch, and the failure that nulled any of them,
// or "" when every requested field rendered. Each root is rendered to native
// JSON at most once and every built-in field derives from that rendering, so a
// stateful MarshalJSON cannot put into one field what another omits. Every
// failure fails its fields closed to nil, and a failed hook never falls back to
// the built-in computation. An Absent root, which a negative-cache entry
// stores, is not a failure: its value field is nil, and the built-in reports
// the other root whole at "". hook is nil when the operation has none.
func renderShadowMismatchLog(logValue bool, diff MismatchDiffLevel, cached, source any, hook func() ([]MismatchEntry, error)) (fields map[string]any, failure string) {
	fields = map[string]any{}
	var cachedJSON, sourceJSON []byte
	renderFailed, diffFailed := false, false
	if logValue || (diff.on() && hook == nil) {
		var cachedFailed, sourceFailed bool
		cachedJSON, cachedFailed = renderRoot(cached)
		sourceJSON, sourceFailed = renderRoot(source)
		renderFailed = cachedFailed || sourceFailed
	}
	if diff.on() {
		withValues := diff == MismatchDiffValues
		var entries []MismatchEntry
		count, computed := 0, false
		if hook != nil {
			entries, count, computed = runMismatchHook(hook)
			diffFailed = !computed
		} else if !renderFailed {
			entries, count, computed = walkRenderedJSON(cachedJSON, sourceJSON)
			diffFailed = !computed
		}
		if !computed {
			fields["mismatchPaths"], fields["mismatchPathCount"] = nil, nil
			if withValues {
				fields["diffJson"] = nil
			}
		} else {
			// "paths" never renders a side.
			paths := make([]string, len(entries))
			for i, entry := range entries {
				paths[i] = clampLogUTF8(entry.Path, shadowMismatchPathMaxBytes)
			}
			fields["mismatchPaths"], fields["mismatchPathCount"] = paths, count
			if withValues {
				if encoded, rendered := appendMismatchEntries(nil, entries); rendered {
					fields["diffJson"] = clampLogUTF8(string(encoded), shadowLogDiffMaxBytes)
				} else {
					fields["diffJson"] = nil
					renderFailed = true
				}
			}
		}
	}
	if logValue {
		fields["cachedValueJson"], fields["sourceValueJson"] = valueLogField(cachedJSON), valueLogField(sourceJSON)
	}
	switch {
	case diffFailed:
		failure = shadowLogHookError
	case renderFailed:
		failure = shadowLogRenderError
	}
	return fields, failure
}

// renderJSON renders one value to native JSON. A value with no rendering,
// including one whose MarshalJSON panics, reports false.
func renderJSON(value any) (encoded []byte, rendered bool) {
	// A panic skips the return, leaving both results zero.
	defer func() { _ = recover() }()
	encoded, err := appendJSON(nil, reflect.ValueOf(value), make(map[visit]bool))
	return encoded, err == nil
}

// renderRoot renders a compared value; nil bytes mean no rendering, and failed
// separates a value with no rendering from an Absent one.
func renderRoot(value any) (encoded []byte, failed bool) {
	if IsAbsent(value) {
		return nil, false
	}
	encoded, rendered := renderJSON(value)
	return encoded, !rendered
}

func valueLogField(encoded []byte) any {
	if encoded == nil {
		return nil
	}
	return clampLogUTF8(string(encoded), ShadowLogValueMaxBytes)
}

// walkRenderedJSON runs the built-in computation over two root renderings;
// nil is an Absent root, since a root that failed to render never reaches it.
// computed is false when a rendering does not parse back, as for nesting past
// encoding/json's depth limit.
func walkRenderedJSON(cachedJSON, sourceJSON []byte) (entries []MismatchEntry, count int, computed bool) {
	if bytes.Equal(cachedJSON, sourceJSON) {
		return nil, 0, true
	}
	cached, source := any(Absent), any(Absent)
	for _, side := range []struct {
		encoded []byte
		parsed  *any
	}{{cachedJSON, &cached}, {sourceJSON, &source}} {
		if side.encoded == nil {
			continue
		}
		var parsed any
		if err := json.Unmarshal(side.encoded, &parsed); err != nil {
			return nil, 0, false
		}
		*side.parsed = parsed
	}
	if IsAbsent(cached) || IsAbsent(source) {
		return []MismatchEntry{{Path: "", Cached: cached, Source: source}}, 1, true
	}
	entries, count = walkJSON(cached, source)
	return entries, count, true
}

type jsonKind int

const (
	jsonPrimitive jsonKind = iota
	jsonArray
	jsonObject
)

func kindOfJSON(value any) jsonKind {
	switch value.(type) {
	case []any:
		return jsonArray
	case map[string]any:
		return jsonObject
	}
	return jsonPrimitive
}

// walkJSON is the built-in difference computation over two parsed JSON
// values. Objects recurse over the union of their member names in UTF-16
// code-unit order, and a member present on one side only is reported at its
// pointer with the other side Absent. Arrays of equal length recurse by index;
// arrays of different length are reported once at their own pointer. Any other
// differing pair, roots of different kinds included, is reported at its pointer
// with both sides, and a differing pair of containers at shadowMismatchMaxDepth
// reference tokens is reported whole without descending. Entries keep walk
// order and are cut at shadowMismatchMaxEntries; count is the uncut total.
func walkJSON(cached, source any) (entries []MismatchEntry, count int) {
	entries = []MismatchEntry{}
	report := func(entry MismatchEntry) {
		count++
		if len(entries) < shadowMismatchMaxEntries {
			entries = append(entries, entry)
		}
	}
	var walk func(left, right any, path string, depth int)
	walk = func(left, right any, path string, depth int) {
		kind := kindOfJSON(left)
		if kind != kindOfJSON(right) {
			report(MismatchEntry{Path: path, Cached: left, Source: right})
			return
		}
		if kind == jsonPrimitive {
			if left != right {
				report(MismatchEntry{Path: path, Cached: left, Source: right})
			}
			return
		}
		if depth >= shadowMismatchMaxDepth {
			if !jsonValuesEqual(left, right) {
				report(MismatchEntry{Path: path, Cached: left, Source: right})
			}
			return
		}
		if kind == jsonArray {
			leftItems, rightItems := left.([]any), right.([]any)
			if len(leftItems) != len(rightItems) {
				report(MismatchEntry{Path: path, Cached: left, Source: right})
				return
			}
			for index := range leftItems {
				walk(leftItems[index], rightItems[index], path+"/"+strconv.Itoa(index), depth+1)
			}
			return
		}
		leftMembers, rightMembers := left.(map[string]any), right.(map[string]any)
		names := make([]string, 0, len(leftMembers)+len(rightMembers))
		for name := range leftMembers {
			names = append(names, name)
		}
		for name := range rightMembers {
			if _, shared := leftMembers[name]; !shared {
				names = append(names, name)
			}
		}
		sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })
		for _, name := range names {
			memberPath := path + "/" + escapePointerToken(name)
			leftMember, inLeft := leftMembers[name]
			rightMember, inRight := rightMembers[name]
			switch {
			case !inRight:
				report(MismatchEntry{Path: memberPath, Cached: leftMember, Source: Absent})
			case !inLeft:
				report(MismatchEntry{Path: memberPath, Cached: Absent, Source: rightMember})
			default:
				walk(leftMember, rightMember, memberPath, depth+1)
			}
		}
	}
	walk(cached, source, "", 0)
	return entries, count
}

// jsonValuesEqual compares a depth-capped pair structurally. It is iterative,
// so a subtree as deep as rendering allows cannot exhaust the stack.
func jsonValuesEqual(cached, source any) bool {
	pending := [][2]any{{cached, source}}
	for len(pending) > 0 {
		pair := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		switch left := pair[0].(type) {
		case []any:
			right, ok := pair[1].([]any)
			if !ok || len(left) != len(right) {
				return false
			}
			for index := range left {
				pending = append(pending, [2]any{left[index], right[index]})
			}
		case map[string]any:
			right, ok := pair[1].(map[string]any)
			if !ok || len(left) != len(right) {
				return false
			}
			for name, member := range left {
				other, present := right[name]
				if !present {
					return false
				}
				pending = append(pending, [2]any{member, other})
			}
		default:
			if kindOfJSON(pair[1]) != jsonPrimitive || pair[0] != pair[1] {
				return false
			}
		}
	}
	return true
}

func escapePointerToken(name string) string {
	return strings.ReplaceAll(strings.ReplaceAll(name, "~", "~0"), "/", "~1")
}

// runMismatchHook runs the operation's hook, which replaces the built-in
// computation. A returned error or panic fails it; the entries are cut at
// shadowMismatchMaxEntries and count is the uncut total.
func runMismatchHook(hook func() ([]MismatchEntry, error)) (entries []MismatchEntry, count int, computed bool) {
	entries, err := callSafely(hook)
	if err != nil {
		return nil, 0, false
	}
	count = len(entries)
	if count > shadowMismatchMaxEntries {
		entries = entries[:shadowMismatchMaxEntries]
	}
	return entries, count, true
}

// appendMismatchEntries renders entries with their bounded sides, the one
// clamp rule for built-in and hook entries: each pointer is clamped, and each
// side that is not Absent is rendered once and kept as JSON, or as its clamped
// text when the rendering exceeds the side cap. rendered is false at the first
// side with no JSON rendering, and later sides are not rendered.
func appendMismatchEntries(dst []byte, entries []MismatchEntry) (encoded []byte, rendered bool) {
	dst = append(dst, '[')
	for index, entry := range entries {
		if index > 0 {
			dst = append(dst, ',')
		}
		dst = append(dst, `{"path":`...)
		dst = quoteJSON(dst, clampLogUTF8(entry.Path, shadowMismatchPathMaxBytes))
		for _, side := range [2]struct {
			name  string
			value any
		}{{"cached", entry.Cached}, {"source", entry.Source}} {
			if IsAbsent(side.value) {
				continue
			}
			rendering, ok := renderJSON(side.value)
			if !ok {
				return nil, false
			}
			dst = append(dst, `,"`+side.name+`":`...)
			if len(rendering) > shadowMismatchSideMaxBytes {
				dst = quoteJSON(dst, clampLogUTF8(string(rendering), shadowMismatchSideMaxBytes))
			} else {
				dst = append(dst, rendering...)
			}
		}
		dst = append(dst, '}')
	}
	return append(dst, ']'), true
}
