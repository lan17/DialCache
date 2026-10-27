package dialcache_test

import (
	. "github.com/lan17/DialCache/go"
	"math"
	"testing"
	"time"
)

func policyTestPtr[T any](value T) *T { return &value }
func policyTestIdentity() Identity {
	return Identity{Namespace: "policy", KeyType: "item", ID: "one", UseCase: "lookup"}
}

func TestPolicySparseResolutionAndSnapshots(t *testing.T) {
	base, err := ParsePolicy(map[string]any{
		"requestLocal": true, "coalesce": false,
		"ttlSec":                map[string]any{"local": 1.0, "remote": 2.0},
		"staleOnErrorMaxAgeSec": 5.0, "remoteReadTimeoutMs": 30.0,
		"shadow": map[string]any{"ramp": 100.0, "logMismatches": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolvePolicy(base, JSONPolicy{
		"ttlSec": map[string]any{"remote": 4.0},
		"ramp":   map[string]any{"local": 0.0},
		"shadow": map[string]any{"logMismatches": false},
	}, policyTestIdentity(), PolicyDefaults{RemoteReadTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !resolved.RequestLocal || resolved.Coalesce || resolved.Local.Enabled || resolved.Local.Reason != "ramped_down" || !resolved.Local.Configured || resolved.Local.TTL != time.Second || !resolved.Remote.Enabled || resolved.Remote.TTL != 4*time.Second || resolved.StaleOnErrorMaxAge != 5*time.Second || resolved.RemoteReadTimeout != 30*time.Millisecond || !resolved.Shadow.Enabled || resolved.Shadow.LogValue || resolved.Shadow.LogDiff != MismatchDiffOff || resolved.Shadow.LoggingConfigError {
		t.Fatalf("wrong sparse policy: %+v", resolved)
	}
	copy := SnapshotPolicy(base)
	*base.RemoteReadTimeout = 99 * time.Millisecond
	*base.Shadow.Ramp = 0
	if *copy.RemoteReadTimeout != 30*time.Millisecond || *copy.Shadow.Ramp != 100 {
		t.Fatal("static snapshot retained mutable leaves")
	}
	inherit, err := ResolvePolicy(copy, nil, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !inherit.Local.Enabled || inherit.RemoteReadTimeout != 30*time.Millisecond {
		t.Fatalf("null provider failed inheritance: %+v %v", inherit, err)
	}
}

func TestPolicyStaticValidation(t *testing.T) {
	for _, config := range []any{
		true, []any{}, map[string]any{"shadowRamp": 1}, map[string]any{"ttlSec": nil},
		map[string]any{"requestLocal": nil}, map[string]any{"coalesce": "false"},
		map[string]any{"ttlSec": map[string]any{"local": 0}},
		map[string]any{"ttlSec": map[string]any{"local": 1.5}},
		map[string]any{"ttlSec": map[string]any{"remote": 31536001}},
		map[string]any{"ramp": map[string]any{"remote": math.NaN()}},
		map[string]any{"remoteReadTimeoutMs": 0}, map[string]any{"remoteReadTimeoutMs": 2147483648},
		map[string]any{"staleOnErrorMaxAgeSec": 2},
		map[string]any{"ttlSec": map[string]any{"remote": 2}, "staleOnErrorMaxAgeSec": 2},
		map[string]any{"shadow": map[string]any{"logMismatches": 1}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": nil}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": "paths"}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": map[string]any{"value": "true"}}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": map[string]any{"value": nil}}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": map[string]any{"diff": "full"}}},
		map[string]any{"shadow": map[string]any{"mismatchLogging": map[string]any{"diff": true}}},
	} {
		if _, err := ParsePolicy(config); err == nil {
			t.Fatalf("accepted invalid static config: %#v", config)
		}
	}
	if _, err := ParsePolicy(map[string]any{"ttlSec": map[string]any{"remote": 31536000}, "remoteReadTimeoutMs": 2147483647}); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePolicy(Policy{LocalTTL: time.Duration(1500) * time.Millisecond}); err == nil {
		t.Fatal("accepted fractional second TTL")
	}
	if err := ValidatePolicy(Policy{Shadow: &ShadowPolicy{MismatchLogging: &MismatchLoggingPolicy{Diff: Ptr(MismatchDiffLevel("full"))}}}); err == nil {
		t.Fatal("accepted an unknown static diff level")
	}
	parsed, err := ParsePolicy(map[string]any{"shadow": map[string]any{"mismatchLogging": map[string]any{"value": false, "diff": MismatchDiffPaths}}})
	if err != nil || parsed.Shadow.MismatchLogging == nil || *parsed.Shadow.MismatchLogging.Value || *parsed.Shadow.MismatchLogging.Diff != MismatchDiffPaths {
		t.Fatalf("static mismatch-logging leaves: %+v %v", parsed.Shadow, err)
	}
	snapshot := SnapshotPolicy(parsed)
	*parsed.Shadow.MismatchLogging.Value, *parsed.Shadow.MismatchLogging.Diff = true, MismatchDiffValues
	if *snapshot.Shadow.MismatchLogging.Value || *snapshot.Shadow.MismatchLogging.Diff != MismatchDiffPaths {
		t.Fatal("static snapshot retained mutable mismatch-logging leaves")
	}
}

func TestRuntimePolicyFailureScopes(t *testing.T) {
	base := Policy{RequestLocal: true, LocalTTL: time.Duration(1000) * time.Millisecond, RemoteTTL: time.Duration(2000) * time.Millisecond}
	for _, overlay := range []any{false, []any{}, map[string]any{"ttlSec": nil}, map[string]any{"shadow": nil}, map[string]any{"shadow": map[string]any{"mismatchLogging": nil}}, map[string]any{"shadow": map[string]any{"mismatchLogging": []any{}}}, map[string]any{"shadow": map[string]any{"mismatchLogging": "paths"}}, map[string]any{"shadow": map[string]any{"logMismatches": true, "mismatchLogging": 1}}, map[string]any{"requestLocal": nil}, map[string]any{"coalesce": 1}, map[string]any{"remoteReadTimeoutMs": 0}} {
		if _, err := ResolvePolicy(base, RawPolicy(overlay), policyTestIdentity(), PolicyDefaults{}); err == nil {
			t.Fatalf("accepted invalid invocation policy: %#v", overlay)
		}
	}
	for _, test := range []struct {
		overlay       map[string]any
		local, remote string
		recoveryError bool
	}{
		{map[string]any{"ttlSec": map[string]any{"local": nil}}, "invalid_ttl", "", false},
		{map[string]any{"ramp": map[string]any{"remote": true}}, "", "invalid_ramp", false},
		{map[string]any{"staleOnErrorMaxAgeSec": nil}, "", "", true},
		{map[string]any{"staleOnErrorMaxAgeSec": 1}, "", "", true},
		{map[string]any{"staleOnErrorMaxAgeSec": 0}, "", "", false},
		{map[string]any{"ttlSec": map[string]any{"remote": -1}, "staleOnErrorMaxAgeSec": -1}, "", "invalid_ttl", false},
	} {
		r, err := ResolvePolicy(base, JSONPolicy(test.overlay), policyTestIdentity(), PolicyDefaults{})
		if err != nil || !r.RequestLocal || !r.Coalesce || r.Local.Reason != test.local || r.Remote.Reason != test.remote || r.StaleOnErrorConfigError != test.recoveryError {
			t.Fatalf("wrong failure scope: %#v => %+v %v", test.overlay, r, err)
		}
	}
	missing, err := ResolvePolicy(Policy{}, JSONPolicy{"staleOnErrorMaxAgeSec": 3}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !missing.StaleOnErrorConfigError || missing.Remote.Reason != "policy_disabled" {
		t.Fatalf("missing remote TTL: %+v %v", missing, err)
	}
}

func TestRecoveryRetentionAndShadowDiagnosticsRemainIndependent(t *testing.T) {
	base := Policy{RemoteTTL: time.Duration(1000) * time.Millisecond, RemoteRamp: policyTestPtr(0.0), StaleOnErrorMaxAge: Ptr(24 * time.Hour)}
	r, err := ResolvePolicy(base, JSONPolicy{"shadow": map[string]any{"ramp": 100, "logMismatches": "invalid"}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || r.Remote.Enabled || !r.Remote.Configured || r.StaleOnErrorMaxAge != 24*time.Hour || !r.Shadow.Enabled || r.Shadow.ConfigError || !r.Shadow.LoggingConfigError || r.Shadow.LogValue || r.Shadow.LogDiff != MismatchDiffOff {
		t.Fatalf("wrong independent options: %+v %v", r, err)
	}
	r, err = ResolvePolicy(base, JSONPolicy{"shadow": map[string]any{"ramp": nil}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !r.Shadow.ConfigError || r.Shadow.Enabled || !r.Remote.Configured {
		t.Fatalf("invalid shadow replaced serving policy: %+v %v", r, err)
	}
}

func TestJSONPolicyIsAnObjectWhereverItAppears(t *testing.T) {
	base := Policy{LocalTTL: time.Second, RemoteTTL: 2 * time.Second}
	nested, err := ResolvePolicy(base, JSONPolicy{"ttlSec": JSONPolicy{"remote": 4}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || nested.Remote.TTL != 4*time.Second || !nested.Local.Enabled {
		t.Fatalf("nested JSONPolicy was not treated as an object: %+v %v", nested, err)
	}
	raw, err := ResolvePolicy(base, RawPolicy(JSONPolicy{"ramp": JSONPolicy{"local": 0}}), policyTestIdentity(), PolicyDefaults{})
	if err != nil || raw.Local.Enabled || raw.Local.Reason != "ramped_down" || !raw.Remote.Enabled {
		t.Fatalf("RawPolicy around JSONPolicy was not treated as an object: %+v %v", raw, err)
	}
	if _, err := ParsePolicy(JSONPolicy{"ttlSec": JSONPolicy{"local": 1}}); err != nil {
		t.Fatalf("ParsePolicy rejected JSONPolicy containers: %v", err)
	}
}

func TestMismatchLoggingRecordedRows(t *testing.T) {
	resolve := func(t *testing.T, static, runtime map[string]any) ResolvedShadow {
		t.Helper()
		var shadow any = Absent
		if static != nil {
			shadow = static
		}
		base, err := ParsePolicy(map[string]any{"shadow": shadow})
		if err != nil {
			t.Fatal(err)
		}
		var overlay RuntimePolicy
		if runtime != nil {
			overlay = JSONPolicy{"shadow": runtime}
		}
		resolved, err := ResolvePolicy(base, overlay, policyTestIdentity(), PolicyDefaults{})
		if err != nil {
			t.Fatal(err)
		}
		return resolved.Shadow
	}
	paths, valueFalse := map[string]any{"diff": "paths"}, map[string]any{"value": false}
	for _, row := range []struct {
		name            string
		static, runtime map[string]any
		value           bool
		diff            MismatchDiffLevel
		invalid         bool
	}{
		{"a static true shorthand beside value false", map[string]any{"logMismatches": true, "mismatchLogging": valueFalse}, nil, false, MismatchDiffValues, false},
		{"a runtime true shorthand beside value false", nil, map[string]any{"logMismatches": true, "mismatchLogging": valueFalse}, false, MismatchDiffValues, false},
		{"a static false shorthand beside diff paths", map[string]any{"logMismatches": false, "mismatchLogging": paths}, nil, false, MismatchDiffPaths, false},
		{"a runtime false shorthand beside diff paths", nil, map[string]any{"logMismatches": false, "mismatchLogging": paths}, false, MismatchDiffPaths, false},
		{"a runtime false shorthand over a static diff paths", map[string]any{"mismatchLogging": paths}, map[string]any{"logMismatches": false}, false, MismatchDiffOff, false},
		{"a runtime true shorthand over a static value false", map[string]any{"mismatchLogging": valueFalse}, map[string]any{"logMismatches": true}, true, MismatchDiffValues, false},
		{"an omitted runtime leaf inheriting the static one", map[string]any{"mismatchLogging": map[string]any{"value": true, "diff": "paths"}}, map[string]any{"mismatchLogging": map[string]any{"diff": "values"}}, true, MismatchDiffValues, false},
		{"a static shorthand as a baseline under a runtime leaf", map[string]any{"logMismatches": true}, map[string]any{"mismatchLogging": paths}, true, MismatchDiffPaths, false},
		{"a malformed runtime shorthand whose same-object leaf wins", map[string]any{"mismatchLogging": map[string]any{"value": false, "diff": "values"}}, map[string]any{"logMismatches": "yes", "mismatchLogging": map[string]any{"value": true}}, true, MismatchDiffOff, true},
		{"an invalid runtime leaf beside a valid static one", map[string]any{"mismatchLogging": map[string]any{"value": true}}, map[string]any{"mismatchLogging": map[string]any{"diff": "everything"}}, true, MismatchDiffOff, true},
		{"neither layer writing a leaf", nil, map[string]any{"ramp": 100}, false, MismatchDiffOff, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			got := resolve(t, row.static, row.runtime)
			if got.LogValue != row.value || got.LogDiff != row.diff || got.LoggingConfigError != row.invalid {
				t.Fatalf("resolved %+v, want value=%v diff=%s invalid=%v", got, row.value, row.diff, row.invalid)
			}
		})
	}
}

// TestMismatchLoggingResolvesEachLayerExpandedFirst checks the recorded rule,
// written out without the code under test, across every combination: a
// written shorthand stands for both leaves (true: value on and diff "values";
// false or malformed: both off), a leaf written beside it wins within its own
// layer, the runtime layer wins per leaf, an omitted leaf is off, an invalid
// leaf acts off, and any invalid input sets the one LoggingConfigError. Static
// policy stays valid, as registration guarantees.
func TestMismatchLoggingResolvesEachLayerExpandedFirst(t *testing.T) {
	omit := &struct{}{}
	layer := func(shorthand, group any) map[string]any {
		shadow := map[string]any{}
		if shorthand != omit {
			shadow["logMismatches"] = shorthand
		}
		if group != omit {
			shadow["mismatchLogging"] = group
		}
		return shadow
	}
	written := func(shadow map[string]any) (value, diff any) {
		value, diff = Absent, Absent
		if shorthand, present := shadow["logMismatches"]; present && !IsAbsent(shorthand) {
			value, diff = shorthand == true, "off"
			if shorthand == true {
				diff = "values"
			}
		}
		if group, ok := shadow["mismatchLogging"].(map[string]any); ok {
			if leaf, present := group["value"]; present && !IsAbsent(leaf) {
				value = leaf
			}
			if leaf, present := group["diff"]; present && !IsAbsent(leaf) {
				diff = leaf
			}
		}
		return value, diff
	}
	expected := func(static, runtime map[string]any) ResolvedShadow {
		inheritedValue, inheritedDiff := written(static)
		value, diff := written(runtime)
		if IsAbsent(value) {
			value = inheritedValue
		}
		if IsAbsent(diff) {
			diff = inheritedDiff
		}
		_, isBool := value.(bool)
		validValue := IsAbsent(value) || isBool
		level, _ := diff.(string)
		validDiff := IsAbsent(diff) || level == "off" || level == "paths" || level == "values"
		shorthand, present := runtime["logMismatches"]
		_, boolShorthand := shorthand.(bool)
		result := ResolvedShadow{LogValue: validValue && value == true, LogDiff: MismatchDiffOff}
		if validDiff && !IsAbsent(diff) {
			result.LogDiff = MismatchDiffLevel(level)
		}
		result.LoggingConfigError = (present && !IsAbsent(shorthand) && !boolShorthand) || !validValue || !validDiff
		return result
	}
	// typed returns the runtime group as a PolicyOverlay when every written
	// value has a typed form; a nil pointer is the typed unwritten leaf.
	typed := func(shadow map[string]any) (*PolicyOverlay, bool) {
		policy := &ShadowPolicy{}
		if shorthand, present := shadow["logMismatches"]; present && !IsAbsent(shorthand) {
			flag, ok := shorthand.(bool)
			if !ok {
				return nil, false
			}
			policy.LogMismatches = &flag
		}
		if group, present := shadow["mismatchLogging"]; present && !IsAbsent(group) {
			leaves, _ := group.(map[string]any)
			policy.MismatchLogging = &MismatchLoggingPolicy{}
			if leaf, present := leaves["value"]; present && !IsAbsent(leaf) {
				flag, ok := leaf.(bool)
				if !ok {
					return nil, false
				}
				policy.MismatchLogging.Value = &flag
			}
			if leaf, present := leaves["diff"]; present && !IsAbsent(leaf) {
				level, ok := leaf.(string)
				if !ok {
					return nil, false
				}
				policy.MismatchLogging.Diff = Ptr(MismatchDiffLevel(level))
			}
		}
		return &PolicyOverlay{Shadow: policy}, true
	}
	staticShorthands := []any{omit, Absent, true, false}
	staticGroups := []any{
		omit, Absent, map[string]any{},
		map[string]any{"value": true}, map[string]any{"value": false},
		map[string]any{"diff": "paths"}, map[string]any{"diff": "off"},
		map[string]any{"value": true, "diff": "values"}, map[string]any{"value": Absent, "diff": "paths"},
	}
	runtimeShorthands := []any{omit, Absent, true, false, "yes", nil, 0}
	runtimeGroups := []any{
		omit, Absent,
		map[string]any{"value": true}, map[string]any{"value": false},
		map[string]any{"diff": "paths"}, map[string]any{"diff": "values"},
		map[string]any{"value": true, "diff": "off"},
		map[string]any{"value": "yes"}, map[string]any{"value": nil},
		map[string]any{"diff": "full"}, map[string]any{"diff": "toString"},
		map[string]any{"value": Absent},
	}
	combinations, typedCombinations := 0, 0
	for _, staticShorthand := range staticShorthands {
		for _, staticGroup := range staticGroups {
			static := layer(staticShorthand, staticGroup)
			base, err := ParsePolicy(map[string]any{"shadow": static})
			if err != nil {
				t.Fatal(err)
			}
			for _, runtimeShorthand := range runtimeShorthands {
				for _, runtimeGroup := range runtimeGroups {
					runtime := layer(runtimeShorthand, runtimeGroup)
					want := expected(static, runtime)
					overlays := []RuntimePolicy{JSONPolicy{"shadow": runtime}, RawPolicy(map[string]any{"shadow": runtime})}
					if overlay, ok := typed(runtime); ok {
						overlays = append(overlays, overlay)
						typedCombinations++
					}
					for _, overlay := range overlays {
						resolved, err := ResolvePolicy(base, overlay, policyTestIdentity(), PolicyDefaults{})
						got := resolved.Shadow
						if err != nil || got.LogValue != want.LogValue || got.LogDiff != want.LogDiff || got.LoggingConfigError != want.LoggingConfigError {
							t.Fatalf("static %#v, runtime %#v (%T): got %+v %v, want %+v", static, runtime, overlay, got, err, want)
						}
						combinations++
					}
				}
			}
		}
	}
	if typedCombinations != 4*9*4*10 || combinations != 4*9*7*12*2+typedCombinations {
		t.Fatalf("ran %d combinations, %d typed", combinations, typedCombinations)
	}
}
