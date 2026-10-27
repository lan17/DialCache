package dialcache

import (
	"bytes"
	"context"
	"errors"
	"log"
	"math/big"
	"reflect"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/lan17/DialCache/go/internal/logging"
	"github.com/prometheus/client_golang/prometheus"
)

type mismatchRecord struct {
	ID      string   `json:"id"`
	Version int      `json:"version"`
	Tags    []string `json:"tags"`
	Extra   bool     `json:"extra,omitempty"`
}

var (
	mismatchCachedRecord = mismatchRecord{ID: "123", Version: 1, Tags: []string{"a"}}
	mismatchSourceRecord = mismatchRecord{ID: "123", Version: 2, Tags: []string{"a", "b"}, Extra: true}
	mismatchPathFields   = map[string]any{"mismatchPaths": []string{"/extra", "/tags", "/version"}, "mismatchPathCount": 3}
	mismatchDiffFields   = withFields(mismatchPathFields, map[string]any{"diffJson": `[{"path":"/extra","source":true},{"path":"/tags","cached":["a"],"source":["a","b"]},{"path":"/version","cached":1,"source":2}]`})
	mismatchValueFields  = map[string]any{"cachedValueJson": `{"id":"123","tags":["a"],"version":1}`, "sourceValueJson": `{"extra":true,"id":"123","tags":["a","b"],"version":2}`}
	mismatchAllFields    = withFields(mismatchDiffFields, mismatchValueFields)
)

// warningRecorder is the logger and observer of one run: it keeps the
// confirmed-mismatch warnings, the diagnostic events and their interleaving.
type warningRecorder struct {
	mu          sync.Mutex
	warnings    []map[string]any
	events      []Event
	sequence    []string
	panicOnWarn bool
}

func (r *warningRecorder) Debug(string, any) {}
func (r *warningRecorder) Error(string, any) {}
func (r *warningRecorder) Warn(message string, details any) {
	if message != "DialCache shadow validation mismatch" {
		return
	}
	r.mu.Lock()
	r.warnings = append(r.warnings, details.(map[string]any))
	r.sequence = append(r.sequence, "warning")
	r.mu.Unlock()
	if r.panicOnWarn {
		panic("logger unavailable")
	}
}
func (r *warningRecorder) observe(event Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	r.sequence = append(r.sequence, event.Kind)
}
func (r *warningRecorder) outcomes(kind string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	outcomes := []string{}
	for _, event := range r.events {
		if event.Kind == kind {
			outcomes = append(outcomes, event.Outcome)
		}
	}
	return outcomes
}
func (r *warningRecorder) configResolutions() []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	errors := []map[string]any{}
	for _, event := range r.events {
		if event.Kind == "error" && event.Data["error"] == "config_resolution" {
			errors = append(errors, event.Data)
		}
	}
	return errors
}

// confirmedMismatch serves cached from Redis for key "123" on both shadow
// reads and loads source, so a differing pair confirms a mismatch.
type confirmedMismatch[T any] struct {
	useCase        string
	cached, source T
	policy         Policy
	overlay        RuntimePolicy
	comparator     func(cached, source T) (bool, error)
	hook           func(cached, source T) ([]MismatchEntry, error)
	panicOnWarn    bool
	viaCached      bool
	options        []Option
}

// shadowLogging is a remote policy whose shadow cohort admits every key.
func shadowLogging(shadow ShadowPolicy) Policy {
	shadow.Ramp = Ptr(100.0)
	return Policy{RemoteTTL: time.Minute, Shadow: &shadow}
}

// run executes one served-hit call inside a synctest bubble and waits for the
// detached shadow job. The frame was written 30.5 seconds earlier.
func (m confirmedMismatch[T]) run(t *testing.T) (*warningRecorder, T) {
	t.Helper()
	payload, err := (JSONCodec[T]{}).Encode(m.cached)
	if err != nil {
		t.Fatal(err)
	}
	frame := Frame{CreatedAtMS: uint64(time.Now().UnixMilli() - 30500), Payload: payload.Bytes}
	remote := boundaryRemote{read: func(context.Context) (ReadResult, error) { return ReadResult{Kind: "hit", Frame: frame}, nil }}
	recorder := &warningRecorder{panicOnWarn: m.panicOnWarn}
	options := append([]Option{WithRemote(remote), WithLogger(recorder), WithObserver(recorder.observe), WithShadowOutcomes(func(Event) {})}, m.options...)
	if m.overlay != nil {
		options = append(options, WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) { return m.overlay, nil }))
	}
	cache := MustNew(options...)
	op := Operation[T]{Identity: Identity{KeyType: "user_id", ID: "123", UseCase: m.useCase}, Policy: m.policy, Comparator: m.comparator, MismatchDiff: m.hook}
	load := func(context.Context) (T, error) { return m.source, nil }
	var result T
	if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
		if !m.viaCached {
			result, err = GetOrLoad(ctx, cache, op, load)
			return err
		}
		read, err := Cached(cache, op, func(string) (Identity, error) { return Identity{ID: "123"}, nil }, func(ctx context.Context, _ string) (T, error) { return load(ctx) })
		if err != nil {
			return err
		}
		result, err = read(ctx, "123")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	synctest.Wait()
	return recorder, result
}

// mismatchWarning is a warning's metadata for key "123" with the frame's age,
// plus the fields the leaves select.
func mismatchWarning(useCase string, fields map[string]any) map[string]any {
	return withFields(map[string]any{
		"cacheNamespace": "urn", "useCase": useCase, "keyType": "user_id", "outcome": "mismatch",
		"cachedValueAgeSeconds": 30.5, "cacheKey": "urn:user_id:123#" + useCase,
	}, fields)
}

// expectWarning checks the run's one warning and its one logging outcome.
func expectWarning(t *testing.T, recorder *warningRecorder, warning map[string]any, outcome string) {
	t.Helper()
	if verdicts := recorder.outcomes("shadowValidation"); !reflect.DeepEqual(verdicts, []string{"mismatch"}) {
		t.Fatalf("verdicts: %v", verdicts)
	}
	if len(recorder.warnings) != 1 || !reflect.DeepEqual(recorder.warnings[0], warning) {
		t.Fatalf("warnings: %#v\nwant %#v", recorder.warnings, warning)
	}
	if outcomes := recorder.outcomes("shadowMismatchLogging"); !reflect.DeepEqual(outcomes, []string{outcome}) {
		t.Fatalf("logging outcomes: %v, want %s", outcomes, outcome)
	}
}

func expectNoWarning(t *testing.T, recorder *warningRecorder) {
	t.Helper()
	if len(recorder.warnings) != 0 || len(recorder.outcomes("shadowMismatchLogging")) != 0 {
		t.Fatalf("logging off emitted %v and %v", recorder.warnings, recorder.outcomes("shadowMismatchLogging"))
	}
}

func TestShadowMismatchWarningIsOptIn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		recorder, result := confirmedMismatch[mismatchRecord]{useCase: "LoggingOff", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(ShadowPolicy{})}.run(t)
		if !reflect.DeepEqual(result, mismatchCachedRecord) || !reflect.DeepEqual(recorder.outcomes("shadowValidation"), []string{"mismatch"}) {
			t.Fatalf("served %v with verdicts %v", result, recorder.outcomes("shadowValidation"))
		}
		expectNoWarning(t, recorder)
		// A match with logging on emits nothing either.
		recorder, _ = confirmedMismatch[mismatchRecord]{useCase: "LoggingMatch", cached: mismatchCachedRecord, source: mismatchCachedRecord, policy: shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)})}.run(t)
		if !reflect.DeepEqual(recorder.outcomes("shadowValidation"), []string{"match"}) {
			t.Fatalf("verdicts: %v", recorder.outcomes("shadowValidation"))
		}
		expectNoWarning(t, recorder)
	})
}

func TestShadowMismatchWarningFieldsPerLeaves(t *testing.T) {
	hookCalls := 0
	countingHook := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) {
		hookCalls++
		return []MismatchEntry{{Path: "/hook", Cached: Absent, Source: Absent}}, nil
	}
	pathsLevel, valuesLevel := Ptr(MismatchDiffPaths), Ptr(MismatchDiffValues)
	for _, test := range []struct {
		name    string
		static  ShadowPolicy
		overlay RuntimePolicy
		fields  map[string]any
	}{
		{"logMismatches true", ShadowPolicy{LogMismatches: Ptr(true)}, nil, mismatchAllFields},
		{"diff paths", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: pathsLevel}}, nil, mismatchPathFields},
		{"diff values with value false", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: valuesLevel, Value: Ptr(false)}}, nil, mismatchDiffFields},
		{"value alone", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Value: Ptr(true)}}, nil, mismatchValueFields},
		// The record's four rows.
		{"logMismatches true beside value false", ShadowPolicy{LogMismatches: Ptr(true), MismatchLogging: &MismatchLoggingPolicy{Value: Ptr(false)}}, nil, mismatchDiffFields},
		{"logMismatches false beside diff paths", ShadowPolicy{LogMismatches: Ptr(false), MismatchLogging: &MismatchLoggingPolicy{Diff: pathsLevel}}, nil, mismatchPathFields},
		{"a runtime logMismatches false over a static diff paths", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: pathsLevel}}, &PolicyOverlay{Shadow: &ShadowPolicy{LogMismatches: Ptr(false)}}, nil},
		{"a runtime logMismatches true over a static value false", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Value: Ptr(false)}}, JSONPolicy{"shadow": map[string]any{"logMismatches": true}}, mismatchAllFields},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				run := confirmedMismatch[mismatchRecord]{useCase: "Leaves", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(test.static), overlay: test.overlay}
				if test.name == "value alone" {
					run.hook = countingHook
				}
				recorder, _ := run.run(t)
				if len(recorder.configResolutions()) != 0 {
					t.Fatalf("valid leaves recorded %v", recorder.configResolutions())
				}
				if test.fields == nil {
					expectNoWarning(t, recorder)
					return
				}
				expectWarning(t, recorder, mismatchWarning("Leaves", test.fields), "logged")
				// The warning follows the verdict and its age; its one outcome follows it.
				if want := []string{"shadowValidation", "shadowAge", "warning", "shadowMismatchLogging"}; !reflect.DeepEqual(recorder.sequence[len(recorder.sequence)-4:], want) {
					t.Fatalf("sequence: %v", recorder.sequence)
				}
				event := recorder.events[len(recorder.events)-1]
				if want := map[string]any{"cacheNamespace": "urn", "useCase": "Leaves", "keyType": "user_id", "outcome": "logged"}; !reflect.DeepEqual(event.Data, want) || event.Key != "urn:user_id:123#Leaves" {
					t.Fatalf("logging event: %+v", event)
				}
			})
		})
	}
	// A subtest, so the mutation runner credits this assertion to a test.
	t.Run("diff off never runs the hook", func(t *testing.T) {
		if hookCalls != 0 {
			t.Fatalf("diff off still ran the hook %d times", hookCalls)
		}
	})
}

func TestShadowMismatchWarningOnRampedDownPath(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		policy := shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)})
		policy.RemoteRamp = Ptr(0.0)
		recorder, result := confirmedMismatch[mismatchRecord]{useCase: "RampedDown", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: policy}.run(t)
		if !reflect.DeepEqual(result, mismatchSourceRecord) {
			t.Fatalf("ramped-down caller got %v", result)
		}
		expectWarning(t, recorder, mismatchWarning("RampedDown", mismatchAllFields), "logged")
	})
}

func TestShadowMismatchDiffHookThroughCachedAndGetOrLoad(t *testing.T) {
	for _, viaCached := range []bool{false, true} {
		t.Run(map[bool]string{false: "GetOrLoad", true: "Cached"}[viaCached], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls [][2]mismatchRecord
				hook := func(cached, source mismatchRecord) ([]MismatchEntry, error) {
					calls = append(calls, [2]mismatchRecord{cached, source})
					return []MismatchEntry{
						{Path: "/custom", Cached: "c", Source: "s"},
						{Path: "/only-path", Cached: Absent, Source: Absent},
						{Path: "/one-side", Cached: Absent, Source: map[string]any{"nested": true}},
					}, nil
				}
				recorder, _ := confirmedMismatch[mismatchRecord]{useCase: "Hook", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)}), hook: hook, viaCached: viaCached}.run(t)
				if !reflect.DeepEqual(calls, [][2]mismatchRecord{{mismatchCachedRecord, mismatchSourceRecord}}) {
					t.Fatalf("hook calls: %v", calls)
				}
				expectWarning(t, recorder, mismatchWarning("Hook", withFields(mismatchValueFields, map[string]any{
					"mismatchPaths":     []string{"/custom", "/only-path", "/one-side"},
					"mismatchPathCount": 3,
					"diffJson":          `[{"path":"/custom","cached":"c","source":"s"},{"path":"/only-path"},{"path":"/one-side","source":{"nested":true}}]`,
				})), "logged")
			})
		})
	}
}

func TestShadowMismatchWarningFailureOutcomes(t *testing.T) {
	hookError := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) {
		return nil, errors.New("diff hook unavailable")
	}
	hookPanic := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) { panic("diff hook unavailable") }
	unrenderableSide := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) {
		return []MismatchEntry{{Path: "/version", Cached: big.NewInt(1), Source: Absent}}, nil
	}
	panickingSide := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) {
		return []MismatchEntry{{Path: "/version", Cached: Absent, Source: marshalingJSON("panic")}}, nil
	}
	failedDiff := map[string]any{"mismatchPaths": nil, "mismatchPathCount": nil, "diffJson": nil}
	for _, test := range []struct {
		name        string
		leaves      ShadowPolicy
		hook        func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error)
		panicOnWarn bool
		fields      map[string]any
		outcome     string
	}{
		{"the hook returns an error", ShadowPolicy{LogMismatches: Ptr(true)}, hookError, false, withFields(failedDiff, mismatchValueFields), "hook_error"},
		{"the hook panics", ShadowPolicy{LogMismatches: Ptr(true)}, hookPanic, false, withFields(failedDiff, mismatchValueFields), "hook_error"},
		{"the logger panics", ShadowPolicy{LogMismatches: Ptr(true)}, nil, true, mismatchAllFields, "logger_error"},
		{"the hook fails and the logger panics", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffValues)}}, hookError, true, failedDiff, "hook_error"},
		{"a hook side has no rendering and the logger panics", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffValues)}}, unrenderableSide, true, map[string]any{"mismatchPaths": []string{"/version"}, "mismatchPathCount": 1, "diffJson": nil}, "render_error"},
		{"a hook side's MarshalJSON panics", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffValues)}}, panickingSide, false, map[string]any{"mismatchPaths": []string{"/version"}, "mismatchPathCount": 1, "diffJson": nil}, "render_error"},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				recorder, result := confirmedMismatch[mismatchRecord]{useCase: "Failure", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(test.leaves), hook: test.hook, panicOnWarn: test.panicOnWarn}.run(t)
				if !reflect.DeepEqual(result, mismatchCachedRecord) {
					t.Fatalf("warning failure changed the result: %v", result)
				}
				fields := test.fields
				if test.outcome != "logger_error" {
					// The logger never received a logger_error, so it carries none.
					fields = withFields(fields, map[string]any{"loggingOutcome": test.outcome})
				}
				expectWarning(t, recorder, mismatchWarning("Failure", fields), test.outcome)
			})
		})
	}
}

func TestShadowMismatchWarningRenderFailure(t *testing.T) {
	// A source with no JSON rendering nulls its value field and the built-in
	// diff fields, under the default comparator and a custom one.
	for _, comparator := range []func(any, any) (bool, error){nil, func(any, any) (bool, error) { return false, nil }} {
		synctest.Test(t, func(t *testing.T) {
			recorder, _ := confirmedMismatch[any]{useCase: "RenderFailure", cached: map[string]any{"id": "123", "version": 1}, source: failingJSON{}, policy: shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)}), comparator: comparator}.run(t)
			expectWarning(t, recorder, mismatchWarning("RenderFailure", map[string]any{
				"mismatchPaths": nil, "mismatchPathCount": nil, "diffJson": nil,
				"cachedValueJson": `{"id":"123","version":1}`, "sourceValueJson": nil, "loggingOutcome": "render_error",
			}), "render_error")
		})
	}
	// A hook at diff paths renders neither value, so the same source logs.
	synctest.Test(t, func(t *testing.T) {
		hook := func(any, any) ([]MismatchEntry, error) {
			return []MismatchEntry{{Path: "/version", Cached: Absent, Source: Absent}}, nil
		}
		recorder, _ := confirmedMismatch[any]{useCase: "HookPaths", cached: map[string]any{"id": "123"}, source: failingJSON{}, policy: shadowLogging(ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffPaths)}}), hook: hook}.run(t)
		expectWarning(t, recorder, mismatchWarning("HookPaths", map[string]any{"mismatchPaths": []string{"/version"}, "mismatchPathCount": 1}), "logged")
	})
}

func TestShadowMismatchWarningDefaultLogger(t *testing.T) {
	// Pointers carry member names as written. The default logger writes the
	// details as JSON, so each pointer keeps its bounds, and escapes the whole
	// line, so a newline or terminal escape in a name cannot forge a line.
	for _, test := range []struct {
		name           string
		cached, source any
		paths          string
	}{
		{"keeps a forged line on one line", map[string]any{"a\nDialCache forged\x1b[2J": 1}, map[string]any{"a\nDialCache forged\x1b[2J": 2}, `["/a\nDialCache forged\u001b[2J"]`},
		{"quotes the root pointer", 1, "1", `[""]`},
		{"keeps a pointer holding a space one element", map[string]any{"a b": 1}, map[string]any{"a b": 2}, `["/a b"]`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			writer, flags := log.Writer(), log.Flags()
			log.SetOutput(&output)
			log.SetFlags(0)
			defer func() { log.SetOutput(writer); log.SetFlags(flags) }()
			synctest.Test(t, func(t *testing.T) {
				recorder, _ := confirmedMismatch[any]{useCase: "DefaultLogger", cached: test.cached, source: test.source,
					policy: shadowLogging(ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffPaths)}}), options: []Option{WithLogger(logging.Logger{})}}.run(t)
				if outcomes := recorder.outcomes("shadowMismatchLogging"); !reflect.DeepEqual(outcomes, []string{"logged"}) {
					t.Fatalf("logging outcomes: %v", outcomes)
				}
			})
			want := `DialCache shadow validation mismatch: {"cacheKey":"urn:user_id:123#DefaultLogger","cacheNamespace":"urn","cachedValueAgeSeconds":30.5,"keyType":"user_id","mismatchPathCount":1,"mismatchPaths":` + test.paths + `,"outcome":"mismatch","useCase":"DefaultLogger"}` + "\n"
			if output.String() != want {
				t.Fatalf("logged %q, want %q", output.String(), want)
			}
		})
	}
}

func TestShadowMismatchWarningAbsentCachedValue(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// The default codec stores a negative-cache entry as Absent.
		recorder, result := confirmedMismatch[any]{useCase: "AbsentCached", cached: Absent, source: map[string]any{"id": "123"}, policy: shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)})}.run(t)
		if !IsAbsent(result) {
			t.Fatalf("served %v", result)
		}
		expectWarning(t, recorder, mismatchWarning("AbsentCached", map[string]any{
			"mismatchPaths": []string{""}, "mismatchPathCount": 1, "diffJson": `[{"path":"","source":{"id":"123"}}]`,
			"cachedValueJson": nil, "sourceValueJson": `{"id":"123"}`,
		}), "logged")
	})
}

func TestShadowMismatchWarningRuntimeConfig(t *testing.T) {
	configResolution := map[string]any{"cacheNamespace": "urn", "useCase": "Config", "keyType": "user_id", "layer": "remote", "error": "config_resolution", "inFallback": false}
	for _, test := range []struct {
		name    string
		static  ShadowPolicy
		overlay RuntimePolicy
		errors  int
		fields  map[string]any
	}{
		{"an invalid runtime shorthand fails closed", ShadowPolicy{LogMismatches: Ptr(true)}, JSONPolicy{"shadow": map[string]any{"logMismatches": "yes"}}, 1, nil},
		{"an invalid runtime leaf keeps the valid static leaf", ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Value: Ptr(true)}}, JSONPolicy{"shadow": map[string]any{"mismatchLogging": map[string]any{"diff": "everything"}}}, 1, mismatchValueFields},
		{"a malformed runtime shorthand logs the leaves beside it", ShadowPolicy{LogMismatches: Ptr(true)}, JSONPolicy{"shadow": map[string]any{"logMismatches": "yes", "mismatchLogging": map[string]any{"value": false, "diff": "paths"}}}, 1, mismatchPathFields},
		{"a typed invalid diff level acts off", ShadowPolicy{LogMismatches: Ptr(true)}, &PolicyOverlay{Shadow: &ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffLevel("all"))}}}, 1, mismatchValueFields},
		{"a runtime logMismatches false kills every inherited leaf", ShadowPolicy{LogMismatches: Ptr(true), MismatchLogging: &MismatchLoggingPolicy{Value: Ptr(true), Diff: Ptr(MismatchDiffValues)}}, &PolicyOverlay{Shadow: &ShadowPolicy{LogMismatches: Ptr(false)}}, 0, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				recorder, _ := confirmedMismatch[mismatchRecord]{useCase: "Config", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(test.static), overlay: test.overlay}.run(t)
				if errors := recorder.configResolutions(); len(errors) != test.errors || (test.errors == 1 && !reflect.DeepEqual(errors[0], configResolution)) {
					t.Fatalf("config_resolution errors: %v", errors)
				}
				if test.fields == nil {
					if !reflect.DeepEqual(recorder.outcomes("shadowValidation"), []string{"mismatch"}) {
						t.Fatalf("verdicts: %v", recorder.outcomes("shadowValidation"))
					}
					expectNoWarning(t, recorder)
					return
				}
				expectWarning(t, recorder, mismatchWarning("Config", test.fields), "logged")
			})
		})
	}
}

func TestShadowMismatchLoggingConfigErrorOncePerAdmittedJob(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		payload, _ := (JSONCodec[mismatchRecord]{}).Encode(mismatchCachedRecord)
		frame := Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: payload.Bytes}
		remote := boundaryRemote{read: func(context.Context) (ReadResult, error) { return ReadResult{Kind: "hit", Frame: frame}, nil }}
		recorder := &warningRecorder{}
		overlay := JSONPolicy{"shadow": map[string]any{"logMismatches": "yes", "mismatchLogging": map[string]any{"value": "no", "diff": "all"}}}
		cache := MustNew(WithRemote(remote), WithLogger(recorder), WithObserver(recorder.observe), WithShadowOutcomes(func(Event) {}),
			WithPolicyProvider(func(context.Context, Identity) (RuntimePolicy, error) { return overlay, nil }))
		op := Operation[mismatchRecord]{Identity: Identity{KeyType: "user_id", ID: "123", UseCase: "Config"}, Policy: shadowLogging(ShadowPolicy{})}
		release := make(chan struct{})
		load := func(context.Context) (mismatchRecord, error) { <-release; return mismatchSourceRecord, nil }
		call := func() {
			if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
				_, err := GetOrLoad(ctx, cache, op, load)
				return err
			}); err != nil {
				t.Error(err)
			}
		}
		// The first served hit admits a job whose source blocks; the second
		// finds that job holding the key and is dropped before admission.
		call()
		synctest.Wait()
		call()
		close(release)
		synctest.Wait()
		if verdicts := recorder.outcomes("shadowValidation"); !reflect.DeepEqual(verdicts, []string{"dropped", "mismatch"}) {
			t.Fatalf("verdicts: %v", verdicts)
		}
		// Three invalid inputs, one admitted job: one config_resolution.
		if errors := recorder.configResolutions(); len(errors) != 1 {
			t.Fatalf("config_resolution errors: %v", errors)
		}
		expectNoWarning(t, recorder)
	})
}

func TestShadowMismatchWarningKeepsTheShadowSlot(t *testing.T) {
	// A confirmed mismatch keeps its slot until its warning is logged, so
	// capacity bounds a slow hook as it bounds a slow comparator.
	synctest.Test(t, func(t *testing.T) {
		payload, _ := (JSONCodec[mismatchRecord]{}).Encode(mismatchCachedRecord)
		frame := Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Payload: payload.Bytes}
		remote := boundaryRemote{read: func(context.Context) (ReadResult, error) { return ReadResult{Kind: "hit", Frame: frame}, nil }}
		recorder := &warningRecorder{}
		cache := MustNew(WithRemote(remote), WithLogger(recorder), WithObserver(recorder.observe), WithShadowOutcomes(func(Event) {}), WithShadowCapacity(1))
		release := make(chan struct{})
		hook := func(mismatchRecord, mismatchRecord) ([]MismatchEntry, error) { <-release; return nil, nil }
		call := func(id string) {
			op := Operation[mismatchRecord]{Identity: Identity{KeyType: "user_id", ID: id, UseCase: "Capacity"}, MismatchDiff: hook,
				Policy: shadowLogging(ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffPaths)}})}
			if err := cache.WithEnabled(context.Background(), func(ctx context.Context) error {
				_, err := GetOrLoad(ctx, cache, op, func(context.Context) (mismatchRecord, error) { return mismatchSourceRecord, nil })
				return err
			}); err != nil {
				t.Error(err)
			}
		}
		// The first job confirms its mismatch and blocks in the hook; a job for
		// another key finds no free slot.
		call("123")
		synctest.Wait()
		call("456")
		synctest.Wait()
		verdicts := recorder.outcomes("shadowValidation")
		close(release)
		synctest.Wait()
		if !reflect.DeepEqual(verdicts, []string{"mismatch", "dropped"}) {
			t.Fatalf("verdicts while the hook runs: %v", verdicts)
		}
		// Once the warning is logged, the slot admits the next job.
		call("789")
		synctest.Wait()
		if verdicts := recorder.outcomes("shadowValidation"); !reflect.DeepEqual(verdicts, []string{"mismatch", "dropped", "mismatch"}) {
			t.Fatalf("verdicts: %v", verdicts)
		}
		if outcomes := recorder.outcomes("shadowMismatchLogging"); !reflect.DeepEqual(outcomes, []string{"logged", "logged"}) {
			t.Fatalf("logging outcomes: %v", outcomes)
		}
	})
}

func TestShadowMismatchLoggingExporters(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		registry := prometheus.NewRegistry()
		exporter, err := NewPrometheusMetrics(registry, "")
		if err != nil {
			t.Fatal(err)
		}
		client := &recordingDogStatsD{}
		datadog, err := NewDatadogMetrics(DatadogMetricsOptions{Client: client, ObservationMetricType: "distribution"})
		if err != nil {
			t.Fatal(err)
		}
		run := confirmedMismatch[mismatchRecord]{useCase: "Exported", cached: mismatchCachedRecord, source: mismatchSourceRecord, policy: shadowLogging(ShadowPolicy{LogMismatches: Ptr(true)}), panicOnWarn: true, options: []Option{WithMetrics(exporter), WithMetrics(datadog)}}
		if recorder, _ := run.run(t); !reflect.DeepEqual(recorder.outcomes("shadowMismatchLogging"), []string{"logger_error"}) {
			t.Fatalf("logging outcomes: %v", recorder.outcomes("shadowMismatchLogging"))
		}
		labels := map[string]string{"cache_namespace": "urn", "use_case": "Exported", "key_type": "user_id", "outcome": "logger_error"}
		families, err := registry.Gather()
		if err != nil {
			t.Fatal(err)
		}
		exported := false
		for _, family := range families {
			if family.GetName() != "dialcache_shadow_mismatch_logging_counter" {
				continue
			}
			got := map[string]string{}
			for _, label := range family.Metric[0].Label {
				got[label.GetName()] = label.GetValue()
			}
			exported = len(family.Metric) == 1 && family.Metric[0].Counter.GetValue() == 1 && reflect.DeepEqual(got, labels)
		}
		if !exported {
			t.Fatal("Prometheus did not count the logging outcome")
		}
		counted := false
		for _, metric := range client.events {
			if metric.name == "dialcache.shadow_mismatch_logging.count" {
				counted = metric.method == "increment" && metric.value == 1 && reflect.DeepEqual(metric.tags, labels)
			}
		}
		if !counted {
			t.Fatal("Datadog did not count the logging outcome")
		}
	})
}
