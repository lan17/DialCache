package dialcache

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"time"
)

const MaxDeadlineMS = int64(2147483647)

// Ptr returns a pointer to v, for optional Policy and PolicyOverlay leaves.
func Ptr[T any](v T) *T { return &v }

// Policy is an operation's static policy. Zero TTLs omit a layer; positive
// TTLs are whole seconds. Pointer leaves distinguish omitted settings, which
// inherit defaults and runtime overlays, from explicit zero or false.
type Policy struct {
	// RequestLocal memoizes successful values for the enabled scope's lifetime.
	RequestLocal bool
	// LocalTTL and RemoteTTL enable a layer with an insertion TTL in whole seconds.
	LocalTTL  time.Duration
	RemoteTTL time.Duration
	// LocalRamp and RemoteRamp are cohort percentages from 0 through 100; nil means 100.
	LocalRamp  *float64
	RemoteRamp *float64
	// Coalesce shares one in-flight execution across same-key callers; nil means true.
	Coalesce *bool
	// StaleOnErrorMaxAge is the exclusive age ceiling for serving a retained
	// remote value after an eligible source error. It must exceed RemoteTTL.
	// Nil omits recovery; an explicit zero disables an inherited policy.
	StaleOnErrorMaxAge *time.Duration
	// RemoteReadTimeout overrides the instance remote read deadline.
	RemoteReadTimeout *time.Duration
	Shadow            *ShadowPolicy
}

// ShadowPolicy configures detached remote shadow validation.
type ShadowPolicy struct {
	// Ramp is the shadow cohort percentage; nil and zero disable shadow work.
	Ramp *float64
	// LogMismatches is shorthand for the whole MismatchLogging group: true
	// stands for Value true and Diff MismatchDiffValues, false for both off.
	// Leaves set in this policy's MismatchLogging override what it expands to
	// before a runtime overlay merges.
	LogMismatches *bool
	// MismatchLogging selects the content of the one bounded warning emitted
	// per confirmed mismatch. Omitted leaves default off.
	MismatchLogging *MismatchLoggingPolicy
}

// MismatchLoggingPolicy selects what a confirmed-mismatch warning carries. The
// warning is emitted when Value is true or Diff is above MismatchDiffOff. Nil
// leaves inherit, and runtime overlays merge each leaf independently.
type MismatchLoggingPolicy struct {
	// Value includes bounded native JSON of both compared values.
	Value *bool
	// Diff includes the differing fields at this level.
	Diff *MismatchDiffLevel
}

// MismatchDiffLevel is how much of the structural difference between the
// compared values a confirmed-mismatch warning logs.
type MismatchDiffLevel string

const (
	// MismatchDiffOff logs no difference.
	MismatchDiffOff MismatchDiffLevel = "off"
	// MismatchDiffPaths logs the RFC 6901 JSON Pointers of the differing fields.
	MismatchDiffPaths MismatchDiffLevel = "paths"
	// MismatchDiffValues logs those pointers with the cached and source values
	// at each one.
	MismatchDiffValues MismatchDiffLevel = "values"
)

func (level MismatchDiffLevel) valid() bool {
	return level == MismatchDiffOff || level == MismatchDiffPaths || level == MismatchDiffValues
}

// on reports whether the level logs any difference.
func (level MismatchDiffLevel) on() bool {
	return level == MismatchDiffPaths || level == MismatchDiffValues
}

// PolicyProvider returns a sparse runtime overlay for one invocation. A nil
// overlay inherits the static policy; an error bypasses caching for the call.
type PolicyProvider func(context.Context, Identity) (RuntimePolicy, error)

// RuntimePolicy is a sparse overlay applied over an operation's static
// policy: either a typed *PolicyOverlay or a JSONPolicy in the configuration
// shape shared with TypeScript.
type RuntimePolicy interface{ runtimePolicy() (any, error) }

// PolicyOverlay is a typed sparse overlay. Nil leaves inherit. Durations must
// be whole seconds for TTLs and recovery ages and whole milliseconds for the
// read timeout; other values are treated as invalid leaves with the same
// narrow consequences as an invalid JSON leaf.
type PolicyOverlay struct {
	RequestLocal       *bool
	LocalTTL           *time.Duration
	RemoteTTL          *time.Duration
	LocalRamp          *float64
	RemoteRamp         *float64
	Coalesce           *bool
	StaleOnErrorMaxAge *time.Duration
	RemoteReadTimeout  *time.Duration
	Shadow             *ShadowPolicy
}

// JSONPolicy is a runtime overlay in the JSON configuration shape shared with
// TypeScript: ttlSec and ramp layer maps, requestLocal, coalesce,
// staleOnErrorMaxAgeSec, remoteReadTimeoutMs and shadow. Explicit null leaves
// are invalid; Absent leaves inherit.
type JSONPolicy map[string]any

// RawPolicy wraps an arbitrary decoded JSON value as a runtime overlay so a
// configuration service's reply can pass through unchanged. A value that is
// not an object is an invocation-wide policy error, as in TypeScript.
func RawPolicy(value any) RuntimePolicy { return rawPolicy{value} }

type rawPolicy struct{ value any }

func (p rawPolicy) runtimePolicy() (any, error) { return p.value, nil }

func (p JSONPolicy) runtimePolicy() (any, error) {
	if p == nil {
		return nil, nil
	}
	return map[string]any(p), nil
}

func wholeUnits(d time.Duration, unit time.Duration) any {
	if d%unit == 0 {
		return int64(d / unit)
	}
	return float64(d) / float64(unit)
}

func (p *PolicyOverlay) runtimePolicy() (any, error) {
	if p == nil {
		return nil, nil
	}
	m := map[string]any{}
	ttl, ramp := map[string]any{}, map[string]any{}
	if p.LocalTTL != nil {
		ttl["local"] = wholeUnits(*p.LocalTTL, time.Second)
	}
	if p.RemoteTTL != nil {
		ttl["remote"] = wholeUnits(*p.RemoteTTL, time.Second)
	}
	if p.LocalRamp != nil {
		ramp["local"] = *p.LocalRamp
	}
	if p.RemoteRamp != nil {
		ramp["remote"] = *p.RemoteRamp
	}
	if len(ttl) > 0 {
		m["ttlSec"] = ttl
	}
	if len(ramp) > 0 {
		m["ramp"] = ramp
	}
	if p.RequestLocal != nil {
		m["requestLocal"] = *p.RequestLocal
	}
	if p.Coalesce != nil {
		m["coalesce"] = *p.Coalesce
	}
	if p.StaleOnErrorMaxAge != nil {
		m["staleOnErrorMaxAgeSec"] = wholeUnits(*p.StaleOnErrorMaxAge, time.Second)
	}
	if p.RemoteReadTimeout != nil {
		m["remoteReadTimeoutMs"] = wholeUnits(*p.RemoteReadTimeout, time.Millisecond)
	}
	if p.Shadow != nil {
		m["shadow"] = shadowPolicyMap(p.Shadow)
	}
	return m, nil
}

// shadowPolicyMap writes a typed shadow group in the shared JSON shape.
func shadowPolicyMap(p *ShadowPolicy) map[string]any {
	shadow := map[string]any{}
	if p.Ramp != nil {
		shadow["ramp"] = *p.Ramp
	}
	if p.LogMismatches != nil {
		shadow["logMismatches"] = *p.LogMismatches
	}
	if group := p.MismatchLogging; group != nil {
		leaves := map[string]any{}
		if group.Value != nil {
			leaves["value"] = *group.Value
		}
		if group.Diff != nil {
			leaves["diff"] = string(*group.Diff)
		}
		shadow["mismatchLogging"] = leaves
	}
	return shadow
}

type PolicyDefaults struct{ RemoteReadTimeout time.Duration }
type ResolvedLayer struct {
	Enabled    bool
	Reason     string
	Configured bool // valid TTL and ramp remain available when ramp excludes the key
	TTL        time.Duration
	Ramp       float64
}
type ResolvedShadow struct {
	Enabled bool // cohort selection only; admission still needs an eligible path and hook
	Ramp    float64
	// LogValue and LogDiff are the effective mismatch-logging leaves: each
	// layer's LogMismatches expands first, then the leaves merge, and an
	// invalid leaf acts off.
	LogValue    bool
	LogDiff     MismatchDiffLevel
	ConfigError bool
	// LoggingConfigError covers every invalid logging leaf and shorthand; record
	// it once, only if a job is admitted, as in TypeScript.
	LoggingConfigError bool
}

type ResolvedPolicy struct {
	RequestLocal            bool
	Coalesce                bool
	Local                   ResolvedLayer
	Remote                  ResolvedLayer
	RemoteReadTimeout       time.Duration
	StaleOnErrorMaxAge      time.Duration
	StaleOnErrorConfigError bool
	Shadow                  ResolvedShadow
}

// logsMismatches reports whether a confirmed mismatch emits a warning.
func (s ResolvedShadow) logsMismatches() bool { return s.LogValue || s.LogDiff.on() }

func policyNumber(value any) (float64, bool) {
	if number, ok := value.(json.Number); ok {
		n, err := number.Float64()
		return n, err == nil
	}
	if value == nil {
		return 0, false
	}
	v := reflect.ValueOf(value)
	switch v.Kind() {
	case reflect.Float32, reflect.Float64:
		return v.Float(), true
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(v.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(v.Uint()), true
	}
	return 0, false
}
func finiteRange(value any, min, max float64, integer bool) (float64, bool) {
	n, ok := policyNumber(value)
	return n, ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max && (!integer || math.Trunc(n) == n)
}
func policyTTLMS(value any) (int64, bool) {
	n, ok := finiteRange(value, 1, float64(MaxSupportedDurationMS/1000), true)
	if !ok {
		return 0, false
	}
	return int64(n) * 1000, true
}
func optionalLeaf(config map[string]any, name string) (any, bool) {
	v, present := config[name]
	return v, present && !IsAbsent(v)
}
func policyMap(value any, name string) (map[string]any, error) {
	switch m := value.(type) {
	case map[string]any:
		if m != nil {
			return m, nil
		}
	case JSONPolicy:
		if m != nil {
			return map[string]any(m), nil
		}
	}
	return nil, fmt.Errorf("%w: %s must be an object", ErrInvalidPolicy, name)
}
func invalidPolicy(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidPolicy, fmt.Sprintf(format, args...))
}

// ParsePolicy accepts the static JSON-shaped TypeScript configuration. Explicit
// null leaves remain invalid; nil/Absent for the whole configuration means none.
func ParsePolicy(config any) (Policy, error) {
	p := Policy{}
	if config == nil || IsAbsent(config) {
		return p, nil
	}
	m, err := policyMap(config, "defaultConfig")
	if err != nil {
		return p, err
	}
	if _, present := m["shadowRamp"]; present {
		return p, invalidPolicy("shadowRamp was replaced by shadow.ramp")
	}
	for _, kind := range []string{"ttlSec", "ramp"} {
		value, present := optionalLeaf(m, kind)
		if !present {
			continue
		}
		layers, err := policyMap(value, kind)
		if err != nil {
			return p, err
		}
		for _, layer := range []string{"local", "remote"} {
			v, present := optionalLeaf(layers, layer)
			if !present {
				continue
			}
			if kind == "ttlSec" {
				ttl, ok := policyTTLMS(v)
				if !ok {
					return p, invalidPolicy("invalid static ttlSec.%s", layer)
				}
				if layer == "local" {
					p.LocalTTL = time.Duration(ttl) * time.Millisecond
				} else {
					p.RemoteTTL = time.Duration(ttl) * time.Millisecond
				}
			} else {
				ramp, ok := finiteRange(v, 0, 100, false)
				if !ok {
					return p, invalidPolicy("invalid static ramp.%s", layer)
				}
				if layer == "local" {
					p.LocalRamp = &ramp
				} else {
					p.RemoteRamp = &ramp
				}
			}
		}
	}
	for _, field := range []string{"requestLocal", "coalesce"} {
		v, present := optionalLeaf(m, field)
		if !present {
			continue
		}
		flag, ok := v.(bool)
		if !ok {
			return p, invalidPolicy("%s must be boolean", field)
		}
		if field == "requestLocal" {
			p.RequestLocal = flag
		} else {
			p.Coalesce = Ptr(flag)
		}
	}
	if v, present := optionalLeaf(m, "staleOnErrorMaxAgeSec"); present {
		n, ok := finiteRange(v, 0, float64(MaxSupportedDurationMS/1000), true)
		if !ok {
			return p, invalidPolicy("invalid static staleOnErrorMaxAgeSec")
		}
		p.StaleOnErrorMaxAge = Ptr(time.Duration(n) * time.Second)
	}
	if v, present := optionalLeaf(m, "remoteReadTimeoutMs"); present {
		n, ok := finiteRange(v, 1, float64(MaxDeadlineMS), true)
		if !ok {
			return p, invalidPolicy("invalid remoteReadTimeoutMs")
		}
		p.RemoteReadTimeout = Ptr(time.Duration(n) * time.Millisecond)
	}
	if v, present := optionalLeaf(m, "shadow"); present {
		shadow, err := policyMap(v, "shadow")
		if err != nil {
			return p, err
		}
		p.Shadow = &ShadowPolicy{}
		if v, present := optionalLeaf(shadow, "ramp"); present {
			ramp, ok := finiteRange(v, 0, 100, false)
			if !ok {
				return p, invalidPolicy("invalid static shadow.ramp")
			}
			p.Shadow.Ramp = &ramp
		}
		if v, present := optionalLeaf(shadow, "logMismatches"); present {
			flag, ok := v.(bool)
			if !ok {
				return p, invalidPolicy("shadow.logMismatches must be boolean")
			}
			p.Shadow.LogMismatches = &flag
		}
		if v, present := optionalLeaf(shadow, "mismatchLogging"); present {
			group, err := policyMap(v, "shadow.mismatchLogging")
			if err != nil {
				return p, err
			}
			p.Shadow.MismatchLogging = &MismatchLoggingPolicy{}
			if v, present := optionalLeaf(group, "value"); present {
				flag, ok := v.(bool)
				if !ok {
					return p, invalidPolicy("shadow.mismatchLogging.value must be boolean")
				}
				p.Shadow.MismatchLogging.Value = &flag
			}
			if v, present := optionalLeaf(group, "diff"); present {
				level, ok := resolveDiffLeaf(v)
				if !ok {
					return p, invalidPolicy(`shadow.mismatchLogging.diff must be "off", "paths" or "values"`)
				}
				p.Shadow.MismatchLogging.Diff = &level
			}
		}
	}
	return p, ValidatePolicy(p)
}

// ValidatePolicy checks a static policy; failures wrap ErrInvalidPolicy.
func ValidatePolicy(p Policy) error {
	for _, ttl := range []time.Duration{p.LocalTTL, p.RemoteTTL} {
		if ttl < 0 || ttl > MaxSupportedDuration || ttl%time.Second != 0 {
			return invalidPolicy("static TTL must be whole seconds within 365 days")
		}
	}
	for _, ramp := range []*float64{p.LocalRamp, p.RemoteRamp} {
		if ramp != nil {
			if _, ok := finiteRange(*ramp, 0, 100, false); !ok {
				return invalidPolicy("static ramp must be between zero and 100")
			}
		}
	}
	if p.StaleOnErrorMaxAge != nil {
		age := *p.StaleOnErrorMaxAge
		if age < 0 || age > MaxSupportedDuration || age%time.Second != 0 || (age > 0 && (p.RemoteTTL == 0 || age <= p.RemoteTTL)) {
			return invalidPolicy("static recovery age must be whole seconds exceeding a positive remote TTL")
		}
	}
	if p.RemoteReadTimeout != nil && (*p.RemoteReadTimeout <= 0 || *p.RemoteReadTimeout > MaxDeadline || *p.RemoteReadTimeout%time.Millisecond != 0) {
		return invalidPolicy("remote read timeout must be whole milliseconds between 1ms and %s", MaxDeadline)
	}
	if p.Shadow != nil && p.Shadow.Ramp != nil {
		if _, ok := finiteRange(*p.Shadow.Ramp, 0, 100, false); !ok {
			return invalidPolicy("static shadow ramp must be between zero and 100")
		}
	}
	if p.Shadow != nil && p.Shadow.MismatchLogging != nil && p.Shadow.MismatchLogging.Diff != nil && !p.Shadow.MismatchLogging.Diff.valid() {
		return invalidPolicy(`static shadow mismatch diff must be "off", "paths" or "values"`)
	}
	return nil
}

// SnapshotPolicy detaches every optional leaf from mutable caller-owned memory.
func SnapshotPolicy(p Policy) Policy {
	cloneFloat := func(v *float64) *float64 {
		if v == nil {
			return nil
		}
		copy := *v
		return &copy
	}
	cloneBool := func(v *bool) *bool {
		if v == nil {
			return nil
		}
		copy := *v
		return &copy
	}
	cloneDuration := func(v *time.Duration) *time.Duration {
		if v == nil {
			return nil
		}
		copy := *v
		return &copy
	}
	p.LocalRamp, p.RemoteRamp = cloneFloat(p.LocalRamp), cloneFloat(p.RemoteRamp)
	p.Coalesce = cloneBool(p.Coalesce)
	p.StaleOnErrorMaxAge, p.RemoteReadTimeout = cloneDuration(p.StaleOnErrorMaxAge), cloneDuration(p.RemoteReadTimeout)
	if p.Shadow != nil {
		copy := *p.Shadow
		copy.Ramp = cloneFloat(copy.Ramp)
		copy.LogMismatches = cloneBool(copy.LogMismatches)
		if copy.MismatchLogging != nil {
			group := *copy.MismatchLogging
			group.Value = cloneBool(group.Value)
			if group.Diff != nil {
				diff := *group.Diff
				group.Diff = &diff
			}
			copy.MismatchLogging = &group
		}
		p.Shadow = &copy
	}
	return p
}

func staticPolicyMap(p Policy) map[string]any {
	ttl, ramp := map[string]any{}, map[string]any{}
	if p.LocalTTL > 0 {
		ttl["local"] = int64(p.LocalTTL / time.Second)
	}
	if p.RemoteTTL > 0 {
		ttl["remote"] = int64(p.RemoteTTL / time.Second)
	}
	if p.LocalRamp != nil {
		ramp["local"] = *p.LocalRamp
	}
	if p.RemoteRamp != nil {
		ramp["remote"] = *p.RemoteRamp
	}
	coalesce := true
	if p.Coalesce != nil {
		coalesce = *p.Coalesce
	}
	m := map[string]any{"ttlSec": ttl, "ramp": ramp, "requestLocal": p.RequestLocal, "coalesce": coalesce}
	if p.StaleOnErrorMaxAge != nil {
		m["staleOnErrorMaxAgeSec"] = int64(*p.StaleOnErrorMaxAge / time.Second)
	}
	if p.RemoteReadTimeout != nil {
		m["remoteReadTimeoutMs"] = int64(*p.RemoteReadTimeout / time.Millisecond)
	}
	if p.Shadow != nil {
		m["shadow"] = shadowPolicyMap(p.Shadow)
	}
	return m
}

// mismatchLeaves are the mismatch-logging leaves one shadow group writes,
// before validation. Absent marks an unwritten leaf; invalid marks a malformed
// shorthand, which still owes one config_resolution.
type mismatchLeaves struct {
	value, diff any
	invalid     bool
}

// expandMismatchLogging expands one shadow group's logMismatches shorthand
// into the leaves it stands for, true as Value true and Diff "values" and
// false as both off, then lets the leaves written in the same group's
// mismatchLogging override them. A malformed shorthand expands to both leaves
// off and is marked invalid. A mismatchLogging that is not an object fails
// resolution like a malformed layer map.
func expandMismatchLogging(shadow map[string]any) (mismatchLeaves, error) {
	leaves := mismatchLeaves{value: Absent, diff: Absent}
	if shorthand, present := optionalLeaf(shadow, "logMismatches"); present {
		switch shorthand {
		case true:
			leaves.value, leaves.diff = true, MismatchDiffValues
		case false:
			leaves.value, leaves.diff = false, MismatchDiffOff
		default:
			leaves.value, leaves.diff, leaves.invalid = false, MismatchDiffOff, true
		}
	}
	v, present := optionalLeaf(shadow, "mismatchLogging")
	if !present {
		return leaves, nil
	}
	group, err := policyMap(v, "shadow.mismatchLogging")
	if err != nil {
		return leaves, err
	}
	if v, present := optionalLeaf(group, "value"); present {
		leaves.value = v
	}
	if v, present := optionalLeaf(group, "diff"); present {
		leaves.diff = v
	}
	return leaves, nil
}

// overlaidBy lets each leaf a runtime group wrote win over the inherited
// static one, whose typed shorthand is never invalid.
func (inherited mismatchLeaves) overlaidBy(written mismatchLeaves) mismatchLeaves {
	if IsAbsent(written.value) {
		written.value = inherited.value
	}
	if IsAbsent(written.diff) {
		written.diff = inherited.diff
	}
	return written
}

// resolve validates each leaf independently: an omitted leaf is off, an
// invalid leaf acts off, and invalid reports that the group owes one
// config_resolution.
func (leaves mismatchLeaves) resolve() (value bool, diff MismatchDiffLevel, invalid bool) {
	value, validValue := resolveValueLeaf(leaves.value)
	diff, validDiff := resolveDiffLeaf(leaves.diff)
	return value, diff, leaves.invalid || !validValue || !validDiff
}

// resolveValueLeaf returns the leaf and whether it is valid; an invalid leaf
// acts off.
func resolveValueLeaf(leaf any) (bool, bool) {
	if IsAbsent(leaf) {
		return false, true
	}
	value, valid := leaf.(bool)
	return value, valid
}

// resolveDiffLeaf accepts a level as a string or a MismatchDiffLevel and
// returns it and whether it is valid; an invalid leaf acts off.
func resolveDiffLeaf(leaf any) (MismatchDiffLevel, bool) {
	if IsAbsent(leaf) {
		return MismatchDiffOff, true
	}
	var level MismatchDiffLevel
	switch v := leaf.(type) {
	case string:
		level = MismatchDiffLevel(v)
	case MismatchDiffLevel:
		level = v
	}
	if !level.valid() {
		return MismatchDiffOff, false
	}
	return level, true
}

// ResolvePolicy merges sparse leaves once. A malformed container, boolean or
// read deadline is an invocation-wide error; TTL/ramp errors disable only that
// layer, while an invalid recovery option preserves valid remote serving.
func ResolvePolicy(base Policy, overlay RuntimePolicy, identity Identity, defaults PolicyDefaults) (ResolvedPolicy, error) {
	resolved := ResolvedPolicy{Coalesce: true, RemoteReadTimeout: defaults.RemoteReadTimeout}
	if resolved.RemoteReadTimeout == 0 {
		resolved.RemoteReadTimeout = DefaultRemoteReadTimeout
	}
	if resolved.RemoteReadTimeout <= 0 || resolved.RemoteReadTimeout > MaxDeadline {
		return resolved, invalidPolicy("invalid instance read deadline")
	}
	if err := ValidatePolicy(base); err != nil {
		return resolved, err
	}
	merged := staticPolicyMap(base)
	staticShadow, _ := merged["shadow"].(map[string]any)
	// The static group is written from typed fields, so it always expands.
	logging, _ := expandMismatchLogging(staticShadow)
	var raw any
	if overlay != nil {
		var err error
		if raw, err = overlay.runtimePolicy(); err != nil {
			return resolved, err
		}
	}
	if raw != nil && !IsAbsent(raw) {
		m, err := policyMap(raw, "runtime config")
		if err != nil {
			return resolved, err
		}
		if _, present := m["shadowRamp"]; present {
			return resolved, invalidPolicy("shadowRamp was replaced by shadow.ramp")
		}
		for _, name := range []string{"ttlSec", "ramp", "shadow"} {
			v, present := optionalLeaf(m, name)
			if !present {
				continue
			}
			incoming, err := policyMap(v, name)
			if err != nil {
				return resolved, err
			}
			output, _ := merged[name].(map[string]any)
			if output == nil {
				output = map[string]any{}
			}
			leaves := []string{"local", "remote"}
			if name == "shadow" {
				leaves = []string{"ramp"}
				// Each layer's shorthand expands before the leaf-wise merge, so a
				// runtime logMismatches replaces both inherited leaves while a
				// leaf written beside it still wins within its own layer.
				written, err := expandMismatchLogging(incoming)
				if err != nil {
					return resolved, err
				}
				logging = logging.overlaidBy(written)
			}
			for _, leaf := range leaves {
				if v, present := optionalLeaf(incoming, leaf); present {
					output[leaf] = v
				}
			}
			merged[name] = output
		}
		for _, name := range []string{"requestLocal", "coalesce", "staleOnErrorMaxAgeSec", "remoteReadTimeoutMs"} {
			if v, present := optionalLeaf(m, name); present {
				merged[name] = v
			}
		}
	}
	var ok bool
	resolved.RequestLocal, ok = merged["requestLocal"].(bool)
	if !ok {
		return resolved, invalidPolicy("runtime requestLocal must be boolean")
	}
	resolved.Coalesce, ok = merged["coalesce"].(bool)
	if !ok {
		return resolved, invalidPolicy("runtime coalesce must be boolean")
	}
	if v, present := optionalLeaf(merged, "remoteReadTimeoutMs"); present {
		n, ok := finiteRange(v, 1, float64(MaxDeadlineMS), true)
		if !ok {
			return resolved, invalidPolicy("invalid runtime remoteReadTimeoutMs")
		}
		resolved.RemoteReadTimeout = time.Duration(n) * time.Millisecond
	}
	logical, _, _, err := identity.Keys()
	if err != nil {
		return resolved, err
	}
	ttls, ramps := merged["ttlSec"].(map[string]any), merged["ramp"].(map[string]any)
	resolveLayer := func(layer string) ResolvedLayer {
		result := ResolvedLayer{Reason: "policy_disabled"}
		v, present := optionalLeaf(ttls, layer)
		if !present {
			return result
		}
		ttl, valid := policyTTLMS(v)
		if !valid {
			result.Reason = "invalid_ttl"
			return result
		}
		ramp := float64(100)
		if v, present := optionalLeaf(ramps, layer); present {
			ramp, valid = finiteRange(v, 0, 100, false)
			if !valid {
				result.Reason = "invalid_ramp"
				return result
			}
		}
		result.Configured, result.TTL, result.Ramp = true, time.Duration(ttl)*time.Millisecond, ramp
		result.Enabled = ramp >= 100 || (ramp > 0 && Cohort(logical, layer) < ramp)
		if result.Enabled {
			result.Reason = ""
		} else {
			result.Reason = "ramped_down"
		}
		return result
	}
	resolved.Local, resolved.Remote = resolveLayer("local"), resolveLayer("remote")
	if age, present := optionalLeaf(merged, "staleOnErrorMaxAgeSec"); present {
		n, numeric := policyNumber(age)
		if !resolved.Remote.Configured {
			resolved.StaleOnErrorConfigError = resolved.Remote.Reason == "policy_disabled" && !(numeric && n == 0)
		} else if !(numeric && n == 0) {
			ms, valid := policyTTLMS(age)
			if !valid || time.Duration(ms)*time.Millisecond <= resolved.Remote.TTL {
				resolved.StaleOnErrorConfigError = true
			} else {
				resolved.StaleOnErrorMaxAge = time.Duration(ms) * time.Millisecond
			}
		}
	}
	if shadow, present := merged["shadow"].(map[string]any); present {
		if v, present := optionalLeaf(shadow, "ramp"); present {
			ramp, valid := finiteRange(v, 0, 100, false)
			if !valid {
				resolved.Shadow.ConfigError = true
			} else {
				resolved.Shadow.Ramp = ramp
				resolved.Shadow.Enabled = ramp >= 100 || (ramp > 0 && Cohort(logical, "shadow") < ramp)
			}
		}
	}
	resolved.Shadow.LogValue, resolved.Shadow.LogDiff, resolved.Shadow.LoggingConfigError = logging.resolve()
	return resolved, nil
}
