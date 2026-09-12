import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { actions as effectActions, expectedObservations as effectsObservations, parseTrace as parseEffectsTrace } from "../effects.mjs";
import { expectedObservation as featureObservation, profiles as featureProfiles, parseTrace as parseFeatureTrace } from "../features.mjs";
import { localClockActions, parseLocalClockTrace } from "../local-clock.mjs";
import { admissionWitnesses } from "./admission.mjs";
import { effectsWitnesses } from "./effects.mjs";
import { effectsAuthorityWitnesses } from "./effects-authority.mjs";
import { independentWitnesses } from "./independent.mjs";
import { actionLabels, flowLabels } from "./labels.mjs";
import { layersWitnesses } from "./layers.mjs";
import { localClockWitnesses } from "./local-clock.mjs";
import { localFailureWitnesses } from "./local-failure.mjs";
import { policyWitnesses } from "./policy.mjs";
import { createWitnessRecorder } from "./recorder.mjs";
import { recoveryWitnesses } from "./recovery.mjs";
import { recoveryAdmissionWitnesses } from "./recovery-admission.mjs";
import { recoveryReadWitnesses } from "./recovery-read.mjs";
import { recoveryShadowWitnesses } from "./recovery-shadow.mjs";
import { runtimeWitnesses } from "./runtime.mjs";
import { runtimeBoundaryWitnesses } from "./runtime-boundaries.mjs";
import { scopeWitnesses } from "./scope.mjs";
import { shadowWitnesses } from "./shadow.mjs";
import { shadowDiagnosticsWitnesses } from "./shadow-diagnostics.mjs";
import { shadowLayersWitnesses } from "./shadow-layers.mjs";
import { sourceBudgetsWitnesses } from "./source-budgets.mjs";
import { privateStates, readTrace } from "./trace.mjs";

// One language-neutral witness evaluator for every profile with a completion
// gate. Any port runs it over the same sampled histories and exported
// regressions; TypeScript's test suite calls the same functions. Classifiers
// read declared inputs, public observations and private model predictions from
// the Quint histories only. Driver observations never reach this module, and
// nothing here supplies an implementation's inputs.
export const witnessProfiles = [...Object.keys(featureProfiles), "effects", "local-clock"];

// Parse the corpus once with the shared strict parsers. Feature histories also
// expose their decoded private predictions for the classifiers that need them.
export function loadCorpus(profile, paths) {
  if (profile === "effects") return paths.map(path => parseEffectsTrace(readTrace(path), path));
  if (profile === "local-clock") return paths.map(path => parseLocalClockTrace(readTrace(path), path));
  const definition = featureProfiles[profile];
  if (definition === undefined) throw new Error(`Unknown witness profile ${profile}`);
  return paths.map(path => {
    const raw = readTrace(path);
    return { ...parseFeatureTrace(raw, path, definition), states: privateStates(raw, path) };
  });
}

// Every classifier credits into one recorder, so each label keeps the history
// and the checkpoint step that earned it (recorder.mjs). The returned label
// set is what the completion gate compares with the registry.
export function evaluateCorpus(profile, corpus, paths, recorder = createWitnessRecorder()) {
  switch (profile) {
    case "effects": effectsWitnesses(corpus, recorder); effectsAuthorityWitnesses(paths, recorder); break;
    case "local-clock": localClockWitnesses(corpus, recorder); break;
    case "policy": policyWitnesses(corpus, recorder); runtimeWitnesses(profile, paths, recorder); break;
    case "scope": scopeWitnesses(corpus, recorder); runtimeWitnesses(profile, paths, recorder); break;
    case "layers": layersWitnesses(corpus, recorder); runtimeWitnesses(profile, paths, recorder); break;
    case "admission": admissionWitnesses(corpus, recorder); break;
    case "independent": independentWitnesses(corpus, recorder); break;
    case "recovery": recoveryWitnesses(corpus, recorder); recoveryShadowWitnesses(profile, paths, recorder); break;
    case "shadow":
      shadowWitnesses(corpus, recorder); recoveryShadowWitnesses(profile, paths, recorder); shadowDiagnosticsWitnesses(paths, recorder); break;
    case "recovery-read": actionLabels(corpus, recorder); recoveryReadWitnesses(paths, recorder); recoveryAdmissionWitnesses(paths, recorder); break;
    case "shadow-layers": actionLabels(corpus, recorder); shadowLayersWitnesses(paths, recorder); break;
    case "local-failure": actionLabels(corpus, recorder); localFailureWitnesses(paths, recorder); break;
    case "source-budgets": actionLabels(corpus, recorder); sourceBudgetsWitnesses(paths, recorder); break;
    case "runtime-boundaries": flowLabels(corpus, false, recorder); runtimeBoundaryWitnesses(profile, paths, recorder); break;
    default: throw new Error(`Unknown witness profile ${profile}`);
  }
  return recorder.labels();
}

export function evaluateWitnesses(profile, paths, recorder) {
  return evaluateCorpus(profile, loadCorpus(profile, paths), paths, recorder);
}

// The observation a driver is asserted against at each step of a history: the
// feature coordinator's expected observation (public result record plus its
// diagnostics, IO, marker and compression views where the profile declares
// them), the effects projection, or the local-clock expected record.
export function assertedObservations(profile, trace) {
  if (profile === "effects") return effectsObservations(trace);
  if (profile === "local-clock") return trace.steps.map(step => step.expected);
  return trace.steps.map(step => featureObservation(step));
}

// A history's public identity for the diversity report: its action names in
// order and its asserted observation sequence, both as JSON. Two histories
// share an observation sequence only if every driver would be asserted
// identically at every step.
export function historySequences(profile, trace) {
  return { name: basename(trace.path), actions: JSON.stringify(trace.steps.map(step => step.action)),
    observations: JSON.stringify(assertedObservations(profile, trace)) };
}

// Every declared external action must appear in the corpus. init is the
// initial state, not a transition, and is excluded for the feature profiles.
export function requiredActions(profile) {
  if (profile === "effects") return [...effectActions];
  if (profile === "local-clock") return [...localClockActions];
  const definition = featureProfiles[profile];
  if (definition === undefined) throw new Error(`Unknown witness profile ${profile}`);
  return Object.keys(definition.actions);
}

export function readWitnessRegistry(path = new URL("../../coverage-witnesses.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function requiredWitnesses(profile, registry = readWitnessRegistry()) {
  const required = registry[profile];
  if (!Array.isArray(required) || required.length === 0) throw new Error(`No required witnesses registered for ${profile}`);
  return [...required];
}

// The completion gate: every required label and every declared action must be
// reached. Returns the evaluated labels together with whatever is missing, the
// per-label provenance and each history's public sequences.
export function checkWitnesses(profile, paths, registry = readWitnessRegistry()) {
  if (paths.length === 0) throw new Error(`No ${profile} histories to evaluate`);
  const corpus = loadCorpus(profile, paths);
  const recorder = createWitnessRecorder();
  const seen = evaluateCorpus(profile, corpus, paths, recorder);
  const actions = new Set(corpus.flatMap(trace => trace.steps.map(step => step.action)));
  const required = requiredWitnesses(profile, registry);
  const missing = [...requiredActions(profile).filter(action => !actions.has(action)).map(action => `action:${action}`),
    ...required.filter(label => !seen.has(label))];
  return { profile, traces: paths.length, seen, required, missing, provenance: recorder.provenance(),
    histories: corpus.map(trace => historySequences(profile, trace)) };
}
