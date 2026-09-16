import { explicitInput } from "./trace.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

const successful = value => value !== undefined && value > 0 && value !== 3 && value !== 4;

// The layers runtime classifier inspects only Quint schedules already replayed
// through the public APIs of every port. Private cache predictions select a
// schedule; a later public call must expose retained values, skipped work, or
// independent work. It neither drives implementations nor adds a behavioral
// oracle. (The policy and scope profiles' runtime rules live in policy.mjs and
// scope.mjs; policy.mjs reads no private predictions.)
export function runtimeWitnesses(profile, histories, recorder = createWitnessRecorder()) {
  if (profile !== "layers") return recorder.labels();
  for (const { path, states, predictions } of histories) {
    recorder.enter(path);
    // Published smoke fixtures deliberately retain only public observations.
    if (states[0]?.s?.sources === undefined) continue;
    const steps = predictions.map((s, index) => ({ s, input: index === 0 ? undefined : explicitInput(states[index], `${path} step ${index}`) }));
    layersWitnesses(steps, recorder);
  }
  return recorder.labels();
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
      sourcePublications.set(loader, { value, request, local: source.local, remote: current.writes > prior.writes });
      for (const slot of request) {
        memoOwners.set(slot, loader);
        memoBeforeInvalidation.delete(slot);
      }
      if (source.local) localOwners.set(source.instance * 4 + source.key, loader);
      if (current.writes > prior.writes) remoteOwners.set(source.key, loader);
      if (before.tracked && source.local && !source.remote) trackedLocalOnly.set(source.instance * 4 + source.key, value);
      else if (source.local) trackedLocalOnly.delete(source.instance * 4 + source.key);
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
      if (trackedLocalOnly.get(identity) === value) recorder.credit(before.remoteAvailable ? "tracked-remote-disabled-local-hit" : "tracked-local-only-hit");
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
