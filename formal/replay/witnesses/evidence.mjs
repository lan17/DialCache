import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { replaySources } from "../sources.mjs";

// Reachability is a property of the common input corpus. Ports reuse this
// evaluated witness evidence only after matching every byte of that corpus
// and its definitions, and separately replay all implementation observations.
// The definition inputs are language neutral: the registry, the required
// witnesses, the execution manifest, the profile's model and observation
// library, every Quint library, the shared replay closure (which contains the
// witness classifiers) and the profile's declared witness sources.
export function witnessInputs(profile, directory = ".") {
  const registry = JSON.parse(readFileSync(resolve(directory, "formal/profiles.json"), "utf8"));
  const execution = JSON.parse(readFileSync(resolve(directory, "formal/execution.json"), "utf8"));
  const entry = registry.profiles.find(candidate => candidate.id === profile);
  if (entry === undefined) throw new Error(`Unknown witness profile ${profile}`);
  const inputs = [...new Set(["formal/profiles.json", "formal/coverage-witnesses.json", "formal/execution.json",
    `formal/dialcache-${profile}-conformance.qnt`, "formal/conformance-observations.qnt",
    ...execution.libraries, ...replaySources(directory), ...(entry.witnessSources ?? [])])];
  const foreign = inputs.filter(path => /^(test|src|go)\//.test(path));
  if (foreign.length) throw new Error(`Witness inputs must be language neutral; remove ${foreign.join(", ")} from witnessSources`);
  return inputs;
}

const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const byName = (a, b) => a.name.localeCompare(b.name, "en");

// A history is a sampled trace or a named regression, decided by the corpus
// directory it came from (formal/witnesses.mjs traceKind).
export const traceKinds = ["sampled", "regression"];
function kindOf(kinds, name) {
  const kind = kinds.get(name);
  if (!traceKinds.includes(kind)) throw new Error(`${name}: witness history has no corpus kind`);
  return kind;
}

// Per-label provenance: for every credited label, each history that earned it,
// that history's kind, and the checkpoint steps at which the classifier
// credited it. Sampled and regression hits are counted separately because a
// regression pins a label regardless of seed, while only the sampled count says
// whether random exploration still finds it.
export function labelProvenance(provenance, kinds) {
  return Object.fromEntries(Object.keys(provenance).sort().map(label => {
    const traces = provenance[label].map(({ name, checkpoints }) => ({ name, kind: kindOf(kinds, name), checkpoints })).sort(byName);
    const count = kind => traces.filter(trace => trace.kind === kind).length;
    return [label, { sampled: count("sampled"), regression: count("regression"), traces }];
  }));
}

// Diversity over the sampled histories only: how many distinct action-name
// sequences and how many distinct asserted-observation sequences they contain
// (index.mjs historySequences). Regressions are fixed by name and would only
// inflate both counts.
export function corpusDiversity(histories, kinds) {
  const sampled = histories.filter(history => kindOf(kinds, history.name) === "sampled");
  return { sampledHistories: sampled.length,
    distinctActionSequences: new Set(sampled.map(history => history.actions)).size,
    distinctObservationSequences: new Set(sampled.map(history => history.observations)).size };
}

// check: a checkWitnesses result; corpus: { paths, kinds } from witnessCorpus.
export function witnessEvidence(profile, check, corpus, directory = ".") {
  const inputs = witnessInputs(profile, directory).map(path => ({ path, sha256: hash(resolve(directory, path)) }));
  const digests = corpus.paths.map(path => ({ name: basename(path), sha256: hash(path) })).sort(byName);
  if (new Set(digests.map(({ name }) => name)).size !== digests.length) throw new Error("Witness corpus contains duplicate file names");
  for (const { name } of digests) kindOf(corpus.kinds, name);
  return { schemaVersion: 2, profile, traces: corpus.paths.length, required: [...check.required], seen: [...check.seen].sort(),
    labels: labelProvenance(check.provenance, corpus.kinds), diversity: corpusDiversity(check.histories, corpus.kinds), inputs, corpus: digests };
}

export function writeWitnessEvidence(outputDirectory, evidence) {
  mkdirSync(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, `${evidence.profile}.json`);
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  return path;
}
