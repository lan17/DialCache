package dialcache

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

type behaviorInvocationKey struct{}
type behaviorInvocation struct {
	owner int
}
type behaviorCausalEvent struct {
	kind       string
	id, owner  int
	at, budget int64
	outcome    string
}

type behaviorPropertyAssertion struct{ message string }

func (e *behaviorPropertyAssertion) Error() string { return e.message }

// The mutation runner accepts only explicit property assertions as causal
// evidence. Invalid monitor input and missing ownership remain ordinary errors.
func behaviorPropertyFailure(rule, condition string, event obj) error {
	event["condition"] = condition
	return &behaviorPropertyAssertion{fmt.Sprintf("CAUSAL_PROPERTY_FAILURE rule=%s event=%s", rule, bjson(event))}
}

// This necessary C25/C26 condition links actual external invocation contexts,
// source settlements, and write dispatch. It does not prove payload provenance
// or complete fence/refill authority; those retain their separate observations.
func assertBehaviorCausality(history []behaviorCausalEvent) error {
	type source struct {
		owner                    int
		started, budget, settled int64
		outcome                  string
	}
	sources := map[int]*source{}
	owners := map[int]bool{}
	previous := int64(-1)
	var assertion error
	for index, e := range history {
		fail := func(reason string) error { return fmt.Errorf("C25/C26 causal event %d: %s", index, reason) }
		if e.at < previous {
			return fail("elapsed observations moved backward")
		}
		previous = e.at
		switch e.kind {
		case "sourceStart":
			if e.id < 0 || e.owner < 0 || sources[e.id] != nil || owners[e.owner] {
				return fail("source and invocation ownership must be unique")
			}
			if e.budget == 0 || e.budget < -1 {
				return fail("invalid source budget")
			}
			sources[e.id] = &source{owner: e.owner, started: e.at, budget: e.budget}
			owners[e.owner] = true
		case "sourceSettlement":
			s := sources[e.id]
			if s == nil || s.outcome != "" || (e.outcome != "resolve" && e.outcome != "reject") {
				return fail("settlement must identify one actual pending source")
			}
			s.settled = e.at
			s.outcome = e.outcome
		case "writeDispatch":
			s := sources[e.id]
			if e.owner < 0 || e.id < 0 || s == nil {
				return fail("write has no observed source ownership")
			}
			if s.owner != e.owner {
				if assertion == nil {
					assertion = behaviorPropertyFailure("C26", "write belongs to a different invocation's source", obj{"event": e.kind, "index": index, "atMs": e.at, "source": e.id, "owner": e.owner, "sourceOwner": s.owner})
				}
			}
			if s.outcome != "resolve" {
				if assertion == nil {
					assertion = behaviorPropertyFailure("C26", "write requires that exact source's successful settlement", obj{"event": e.kind, "index": index, "atMs": e.at, "source": e.id, "owner": e.owner, "outcome": s.outcome})
				}
			}
			if s.budget >= 0 && s.settled-s.started >= s.budget {
				if assertion == nil {
					assertion = behaviorPropertyFailure("C25", "late raw settlement cannot authorize publication", obj{"event": e.kind, "index": index, "atMs": e.at, "source": e.id, "owner": e.owner, "startedAtMs": s.started, "settledAtMs": s.settled, "budgetMs": s.budget})
				}
			}
		default:
			return fail("unknown causal event")
		}
	}
	return assertion
}

func (d *behaviorDriver) assertPublicationCausality() error {
	d.mu.Lock()
	events := append([]behaviorCausalEvent(nil), d.causal...)
	d.mu.Unlock()
	return assertBehaviorCausality(events)
}
func TestPublicationCausalityRejectsWrongAndLateSources(t *testing.T) {
	base := []behaviorCausalEvent{{kind: "sourceStart", id: 0, owner: 10, at: 0, budget: 10}, {kind: "sourceStart", id: 1, owner: 20, at: 10, budget: 10}, {kind: "sourceSettlement", id: 0, at: 15, outcome: "resolve"}, {kind: "sourceSettlement", id: 1, at: 16, outcome: "resolve"}}
	for _, test := range []struct {
		name          string
		event         behaviorCausalEvent
		errorContains string
	}{{"late source after replacement accepted", behaviorCausalEvent{kind: "writeDispatch", id: 0, owner: 10, at: 17}, "late raw settlement"}, {"wrong invocation association", behaviorCausalEvent{kind: "writeDispatch", id: 1, owner: 10, at: 17}, "different invocation"}, {"accepted publication after deadline", behaviorCausalEvent{kind: "writeDispatch", id: 1, owner: 20, at: 30}, ""}} {
		t.Run(test.name, func(t *testing.T) {
			history := append(append([]behaviorCausalEvent(nil), base...), test.event)
			err := assertBehaviorCausality(history)
			if test.errorContains == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), test.errorContains) {
				t.Fatalf("causal monitor did not distinguish source ownership: %v", err)
			}
		})
	}
	if err := assertBehaviorCausality(base[:2]); err != nil {
		t.Fatalf("pending prefix rejected: %v", err)
	}
	if err := assertBehaviorCausality([]behaviorCausalEvent{{kind: "sourceStart", id: 0, owner: 0, at: 0, budget: -1}, {kind: "sourceSettlement", id: 0, at: 100000, outcome: "resolve"}, {kind: "writeDispatch", id: 0, owner: 0, at: 100000}}); err != nil {
		t.Fatalf("explicit unbounded source rejected: %v", err)
	}
}

func TestCausalEvidenceExcludesMalformedMonitorInputs(t *testing.T) {
	malformed := [][]behaviorCausalEvent{
		{{kind: "sourceStart", id: 0, owner: 0, at: 0, budget: 0}},
		{{kind: "sourceSettlement", id: 0, at: 0, outcome: "resolve"}},
		{{kind: "sourceStart", id: 0, owner: 0, at: 0, budget: 10}, {kind: "sourceSettlement", id: 0, at: 1, outcome: "unknown"}},
		{{kind: "writeDispatch", id: -1, owner: -1, at: 0}},
	}
	for _, history := range malformed {
		err := assertBehaviorCausality(history)
		if err == nil || strings.Contains(err.Error(), "CAUSAL_PROPERTY_FAILURE") {
			t.Fatalf("malformed monitor input became semantic evidence: %v", err)
		}
	}
	for _, history := range [][]behaviorHistory{
		{{event: "fallbackCompletion", at: 0}},
		{{event: "sourceSettlement", id: 0, at: 0, outcome: "resolve"}},
		{{event: "sourceStart", id: 0, at: 0}, {event: "sourceSettlement", id: 0, at: 1, outcome: "unknown"}},
	} {
		d := &behaviorDriver{history: history}
		err := d.assertEffectsHistory()
		if err == nil || strings.Contains(err.Error(), "CAUSAL_PROPERTY_FAILURE") {
			t.Fatalf("malformed effects monitor input became semantic evidence: %v", err)
		}
	}
	d := &behaviorDriver{history: []behaviorHistory{{event: "sourceStart", id: 0, at: 0}, {event: "sourceSettlement", id: 0, at: 10, outcome: "resolve"}, {event: "fallbackCompletion", at: 10, duration: 10}}}
	if err := d.assertEffectsHistory(); err == nil || !strings.Contains(err.Error(), "CAUSAL_PROPERTY_FAILURE rule=C25 event={") {
		t.Fatalf("deadline violation lacks structured semantic evidence: %v", err)
	}
}

func TestBoundaryRecordingContinuesOnlyCompletePropertyChecks(t *testing.T) {
	d := &behaviorDriver{history: []behaviorHistory{{event: "sourceStart", id: 0, at: 0}, {event: "sourceSettlement", id: 0, at: 10, outcome: "resolve"}, {event: "fallbackCompletion", at: 10, duration: 10}}}
	property := d.assertEffectsHistory()
	t.Setenv("DIALCACHE_REPLAY_DIVERGENCES", "")
	if replayRecordingError(property) == nil {
		t.Fatal("ordinary replay ignored a semantic assertion")
	}
	t.Setenv("DIALCACHE_REPLAY_DIVERGENCES", "recording.jsonl")
	if replayRecordingError(property) != nil {
		t.Fatal("recording stopped before comparing the public observation")
	}
	for _, malformed := range []error{errors.New("driver command failed"), fmt.Errorf("CAUSAL_PROPERTY_FAILURE rule=C25 event={}")} {
		if replayRecordingError(malformed) == nil {
			t.Fatal("untagged driver failure was ignored")
		}
	}
	// An earlier semantic failure cannot conceal an unvalidated later event.
	d.history = append(d.history, behaviorHistory{event: "sourceSettlement", id: 99, at: 10, outcome: "resolve"})
	if replayRecordingError(d.assertEffectsHistory()) == nil {
		t.Fatal("earlier semantic failure concealed malformed effects history")
	}
	history := []behaviorCausalEvent{{kind: "sourceStart", id: 0, owner: 0, at: 0, budget: 10}, {kind: "sourceSettlement", id: 0, at: 10, outcome: "resolve"}, {kind: "writeDispatch", id: 0, owner: 0, at: 10}, {kind: "sourceSettlement", id: 99, at: 10, outcome: "resolve"}}
	if replayRecordingError(assertBehaviorCausality(history)) == nil {
		t.Fatal("earlier semantic failure concealed malformed publication history")
	}
}
