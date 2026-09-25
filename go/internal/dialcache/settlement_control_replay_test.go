package dialcache

import (
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"testing/synctest"
)

// Harness control for the causally-ready-v1 settlement contract (PORTING.md),
// the Go counterpart of typescript/test/formal-settlement-control.test.ts. It replays the
// committed smoke history of every behaviorDriver-backed profile the
// coordinator lists through the shared coordinator twice: once with the
// settling driver, which must pass, and once with a driver that skips the
// settle drain and so reports the observation it held before it. The
// coordinator must reject that replay through the settlement receipt, as a
// `Settlement violation`, and never through an observation comparison: the
// receipt's verification drain finds the work the driver skipped (runnable
// above zero), or its held gates disagree with the command schedule. Were the
// receipt not to catch it, the contract would rest on incidental mismatches and
// a port could pass without ever settling. The unsettled driver still drains
// after its snapshot, so every command starts settled and no failure can be a
// missing gate. The test runs on one scheduler thread so the goroutines a
// command starts cannot run before the snapshot; detection then does not
// depend on scheduling, which is what makes the floor a pin rather than a
// probability. Core and local-clock use awaited drivers, carry no receipt and
// are not covered.
//
// Measured with the receipt probe at 76ba3ef, the unsettled replay is rejected
// at the first step whose drain does work: shadow-layers 2, local-failure 1,
// independent 4, scope 1, policy 1, runtime-boundaries 2, recovery 1,
// source-budgets 1, layers 1, recovery-read 5, admission 1, shadow 1,
// effects 5. The test logs the step it observes for each profile.
//
// The file name ends in _replay_test.go so measure-go-semantics.mjs keeps this
// control out of the ordinary mutation cohort: it is evidence about the
// harness, not about the cache, and must earn no detection credit.

// settlementControlProfiles lists every profile the coordinator serves through
// the behaviorDriver, so a new profile joins the control without an edit here.
func settlementControlProfiles(t *testing.T, coordinator *replayCoordinator) []string {
	t.Helper()
	info, err := coordinator.call(obj{"op": "profiles"})
	if err != nil {
		t.Fatal(err)
	}
	profiles := []string{}
	for name := range bm(info["profiles"]) {
		if name != "core" && name != "local-clock" {
			profiles = append(profiles, name)
		}
	}
	sort.Strings(profiles)
	if len(profiles) == 0 {
		t.Fatal("the coordinator lists no behavior-driver profile")
	}
	return profiles
}

// replaySettlementControl runs one smoke history and returns the replay error,
// if any, instead of failing the test: the caller decides what the error means.
func replaySettlementControl(t *testing.T, coordinator *replayCoordinator, profile string, settle bool) error {
	t.Helper()
	prepared, err := coordinator.prepare(profile, filepath.Join("../../..", "formal", profile+"-smoke.itf.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	var result error
	synctest.Test(t, func(t *testing.T) {
		var d *behaviorDriver
		if settle {
			d = newBehaviorDriver(t, bm(prepared["fixture"]))
		} else {
			d = newUnsettledBehaviorDriver(t, bm(prepared["fixture"]))
		}
		defer d.close()
		result = coordinator.replay(d, prepared)
	})
	return result
}

var settlementViolationStep = regexp.MustCompile(` step (\d+) action `)

func TestHarnessControlNoSettle(t *testing.T) {
	requireRegistry(t)
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))
	coordinator := newReplayCoordinator(t)
	profiles := settlementControlProfiles(t, coordinator)
	detected := []string{}
	undetected := []string{}
	for _, profile := range profiles {
		requireBehaviorProfile(t, profile)
		t.Run(profile+"/settling", func(t *testing.T) {
			if err := replaySettlementControl(t, coordinator, profile, true); err != nil {
				t.Errorf("settling driver failed the committed %s smoke history: %v", profile, err)
			}
		})
		t.Run(profile+"/no-settle", func(t *testing.T) {
			err := replaySettlementControl(t, coordinator, profile, false)
			switch {
			case err == nil:
				undetected = append(undetected, profile)
			case strings.Contains(err.Error(), "Observation mismatch"):
				// An observation mismatch means the receipt let an unsettled
				// observation through and the comparison caught it by chance.
				t.Fatalf("skipping settlement in %s was caught by observation comparison, not by the settlement receipt: %v", profile, err)
			case !strings.Contains(err.Error(), "Settlement violation"):
				// A driver, transport or binding crash is a harness defect,
				// not settlement evidence.
				t.Fatalf("skipping settlement in %s failed without settlement evidence: %v", profile, err)
			case !strings.Contains(err.Error(), "verification drain:"):
				// The driver's account of what its verification drain found
				// travels with the violation, so the failure is diagnosable.
				t.Fatalf("skipping settlement in %s failed without the driver's drain diagnostic: %v", profile, err)
			default:
				detected = append(detected, profile)
				step := "?"
				if match := settlementViolationStep.FindStringSubmatch(err.Error()); match != nil {
					step = match[1]
				}
				t.Logf("%s: settlement violation at step %s", profile, step)
			}
		})
	}
	// The floor is the whole list: the receipt must catch skipped settlement on
	// every behavior smoke history, which is what a third port's control must
	// show as well.
	if len(undetected) > 0 || len(detected) != len(profiles) {
		t.Fatalf("skipping settlement was detected by %d of %d profiles\ndetected: %s\nundetected: %s",
			len(detected), len(profiles), strings.Join(detected, ", "), strings.Join(undetected, ", "))
	}
	t.Logf("harness control: skipping settlement detected as a settlement violation by all %d profiles (%s)", len(detected), strings.Join(detected, ", "))
}
