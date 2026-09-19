package dialcache

import (
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
	if !resolved.RequestLocal || resolved.Coalesce || resolved.Local.Enabled || resolved.Local.Reason != "ramped_down" || !resolved.Local.Configured || resolved.Local.TTL != time.Second || !resolved.Remote.Enabled || resolved.Remote.TTL != 4*time.Second || resolved.StaleOnErrorMaxAge != 5*time.Second || resolved.RemoteReadTimeout != 30*time.Millisecond || !resolved.Shadow.Enabled || resolved.Shadow.LogMismatches {
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
}

func TestRuntimePolicyFailureScopes(t *testing.T) {
	base := Policy{RequestLocal: true, LocalTTL: time.Duration(1000) * time.Millisecond, RemoteTTL: time.Duration(2000) * time.Millisecond}
	for _, overlay := range []any{false, []any{}, map[string]any{"ttlSec": nil}, map[string]any{"shadow": nil}, map[string]any{"requestLocal": nil}, map[string]any{"coalesce": 1}, map[string]any{"remoteReadTimeoutMs": 0}} {
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
	if err != nil || r.Remote.Enabled || !r.Remote.Configured || r.StaleOnErrorMaxAge != 24*time.Hour || !r.Shadow.Enabled || r.Shadow.ConfigError || !r.Shadow.LoggingConfigError || r.Shadow.LogMismatches {
		t.Fatalf("wrong independent options: %+v %v", r, err)
	}
	r, err = ResolvePolicy(base, JSONPolicy{"shadow": map[string]any{"ramp": nil}}, policyTestIdentity(), PolicyDefaults{})
	if err != nil || !r.Shadow.ConfigError || r.Shadow.Enabled || !r.Remote.Configured {
		t.Fatalf("invalid shadow replaced serving policy: %+v %v", r, err)
	}
}
