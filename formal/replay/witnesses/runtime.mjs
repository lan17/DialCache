import { explicitInput } from "./trace.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

const successful = value => value !== undefined && value > 0 && value !== 3 && value !== 4;

// The layers runtime classifier inspects only Quint schedules already replayed
// through the public APIs of every port. Private cache predictions select a
// schedule; a later public call must expose retained values, skipped work, or
// independent work. It neither drives implementations nor adds a behavioral
// oracle. (The policy and scope profiles' runtime rules live in policy.mjs and
// scope.mjs; policy.mjs reads no private predictions.) The tracked local-only
// rule reads the parsed inputs and public observations only.
export function runtimeWitnesses(profile, histories, recorder = createWitnessRecorder()) {
  if (profile !== "layers") return recorder.labels();
  for (const { path, steps, states, predictions } of histories) {
    recorder.enter(path);
    // Excerpt fixtures carry raw states without parsed steps.
    if (steps !== undefined) trackedLocalOnlyWitnesses(path, steps, recorder);
    // Published smoke fixtures deliberately retain only public observations.
    if (states[0]?.s?.sources === undefined) continue;
    const predicted = predictions.map((s, index) => ({ s, input: index === 0 ? undefined : explicitInput(states[index], `${path} step ${index}`) }));
    layersWitnesses(predicted, recorder);
  }
  return recorder.labels();
}

// Tracked reads without a remote adapter (init choice 5: tracked = fixture % 2,
// remote available = fixture < 4). A source a caller starts while the local
// layer is on publishes its settled value to the caller's (instance, key). A
// later caller in a fresh context (3 or 4, so no request memo) on the same
// instance and key that returns that value without starting a source or
// reading was served by that local publication: the fixture has no remote and
// a joined flight leaves the caller pending. The model keeps reads and writes
// at zero here; anything else is a contradiction, not a schedule.
const localLayerOn = policy => policy === 0 || policy === 1 || policy === 3;
function trackedLocalOnlyWitnesses(path, steps, recorder) {
  if (steps[0].choice !== 5) return;
  let policy = 0;
  // Source indices follow o.loaders; a start outside beginCall stays
  // unattributed so later indices still line up.
  const sources = [], published = new Map();
  for (let i = 1; i < steps.length; i++) {
    recorder.step(i);
    const { action, choice, expected: current } = steps[i], prior = steps[i - 1].expected;
    if (current.reads !== 0 || current.writes !== 0) throw new Error(`${path} step ${i}: adapter effects in the fixture without a remote adapter`);
    if (action === "policy") policy = choice;
    if (action === "resolveLoader") {
      const source = sources[Math.floor((choice - 1) / 2)];
      if (source?.localOn) published.set(source.identity, (choice - 1) % 2 + 1);
    }
    if (action !== "beginCall") {
      for (let started = current.loaders - prior.loaders; started > 0; started--) sources.push(undefined);
      continue;
    }
    const context = Math.floor(choice / 4), key = choice % 4;
    const identity = (context === 2 || context === 4 ? 1 : 0) * 4 + key;
    if (current.loaders > prior.loaders) sources.push({ identity, localOn: localLayerOn(policy) });
    const value = current.calls.at(-1);
    if (context >= 3 && current.loaders === prior.loaders && current.reads === prior.reads && successful(value)
      && localLayerOn(policy) && published.get(identity) === value) recorder.credit("tracked-local-only-hit");
  }
}

function layersWitnesses(steps, recorder) {
  const sourcePublications = new Map();
  const probed = new Map();
  const localOwners = new Map();
  const remoteOwners = new Map();
  const memoOwners = new Map();
  const trackedLocalOnly = new Map();
  // A preservation witness must start with an acquired memo. Clear ownership
  // on every later publication, even if the replacement has the same value.
  const memoBeforeInvalidation = new Map();
  for (let i = 1; i < steps.length; i++) {
    recorder.step(i);
    const step = steps[i], before = steps[i - 1].s, after = step.s;
    const prior = before.o, current = after.o, action = step.input.name, choice = step.input.choice;
    if (action === "invalidate" && current.invalidations === prior.invalidations + 1) {
      const entity = choice;
      before.memo.forEach((value, slot) => {
        if (Math.floor((slot % 4) / 2) !== entity) return;
        if (successful(value)) memoBeforeInvalidation.set(slot, value);
        else memoBeforeInvalidation.delete(slot);
      });
    }
    if (action === "seed") remoteOwners.delete(Math.floor(choice / 2));
    if (action === "closeScope") {
      const context = choice;
      for (let key = 0; key < 4; key++) {
        memoOwners.delete(context * 4 + key);
        memoBeforeInvalidation.delete(context * 4 + key);
      }
    }
    for (let key = 0; key < after.localValues.length; key++) if (after.localValues[key] === 0) localOwners.delete(key);
    if (action === "resolveLoader") {
      const loader = Math.floor((choice - 1) / 2);
      const source = before.sources[loader], value = after.sources[loader].result;
      const request = new Set();
      before.owners.forEach((owner, call) => {
        const slot = before.memoSlots[call];
        if (owner === loader && slot >= 0 && !before.closed[Math.floor(slot / 4)]) request.add(slot);
      });
      const warmsLocal = source.localMs > 0;
      sourcePublications.set(loader, { value, request, local: warmsLocal, remote: current.writes > prior.writes });
      for (const slot of request) {
        memoOwners.set(slot, loader);
        memoBeforeInvalidation.delete(slot);
      }
      if (warmsLocal) localOwners.set(source.instance * 4 + source.key, loader);
      if (current.writes > prior.writes) remoteOwners.set(source.key, loader);
      if (before.tracked && warmsLocal && source.retentionMs === 0) trackedLocalOnly.set(source.instance * 4 + source.key, value);
      else if (warmsLocal) trackedLocalOnly.delete(source.instance * 4 + source.key);
    }
    if (action !== "beginCall") continue;
    const context = Math.floor(choice / 4), key = choice % 4;
    const instance = context === 2 || context === 4 ? 1 : 0, identity = instance * 4 + key;
    const value = current.calls.at(-1), starts = current.loaders > prior.loaders;
    const read = current.reads > prior.reads, remoteHit = current.loads > prior.loads;
    const slot = context < 3 && !before.closed[context] && ![1, 5].includes(before.policy) ? context * 4 + key : -1;
    const memoHit = successful(value) && slot >= 0 && before.memo[slot] === value && !read && !starts;
    const localHit = successful(value) && !memoHit && !read && !starts;
    if (memoHit) {
      recorder.credit("request-hit-stops-lower-traversal");
      if (before.tracked && memoBeforeInvalidation.get(slot) === value) {
        recorder.credit("invalidation-preserves-request-hit");
      }
    }
    if (localHit) {
      recorder.credit("local-hit-stops-remote-and-source");
      if (before.remoteAvailable && trackedLocalOnly.get(identity) === value) recorder.credit("tracked-remote-disabled-local-hit");
    }
    if (starts && before.sources.some(source => source.key === key && source.instance !== instance && source.result === 0)) {
      recorder.credit("different-instances-own-distinct-flights");
    }
    if (!successful(value)) continue;
    if (!memoHit && slot >= 0) memoBeforeInvalidation.delete(slot);
    // Keep each layer's writer identity across probes. Equal values from a
    // replacement write cannot be mistaken for the earlier source publication.
    if (remoteHit) {
      const owner = remoteOwners.get(key);
      if (after.localValues[identity] === value && [0, 1].includes(before.policy)) {
        if (owner === undefined) localOwners.delete(identity); else localOwners.set(identity, owner);
        trackedLocalOnly.delete(identity);
      }
      if (slot >= 0) { if (owner === undefined) memoOwners.delete(slot); else memoOwners.set(slot, owner); }
    } else if (localHit && slot >= 0) {
      const owner = localOwners.get(identity);
      if (owner === undefined) memoOwners.delete(slot); else memoOwners.set(slot, owner);
    }
    for (const [loader, publication] of sourcePublications) {
      const source = before.sources[loader];
      if (source.key !== key || publication.value !== value) continue;
      const observations = probed.get(loader) ?? new Set();
      if (memoHit && publication.request.has(slot) && memoOwners.get(slot) === loader) observations.add("request");
      if (localHit && source.instance === instance && publication.local && localOwners.get(identity) === loader) observations.add("local");
      if (remoteHit && publication.remote && remoteOwners.get(key) === loader) observations.add("remote");
      probed.set(loader, observations);
      if (!before.tracked && observations.size === 3) recorder.credit("source-publication-probed-in-all-three-layers");
    }
  }
}
