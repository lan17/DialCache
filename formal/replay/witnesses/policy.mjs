import { isDeepStrictEqual } from "node:util";
import { actionLabels } from "./labels.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// The policy witnesses are decided from the recorded inputs and the asserted
// observation alone; no rule reads the model's private state, so the profile
// can be recomposed from the kernel library without changing a count. What a
// rule needs beyond the observation deltas is shadowed here from the inputs:
// the overlay code and fault switches, both clocks, each caller's key, the
// publication policy a started source captured, and the cache contents the
// public outcomes imply (what a settlement or a remote hit stored in the local
// slot and until when; what a seed or a stored write left in Redis, created at
// which wall time and retained until when). Which layer served a caller is
// read from the observation itself: its result, and whether reads, loads or
// loaders grew.
//
// Two things bind the shadow to the model. Public-only cross-checks inside the
// shadow throw on a contradiction between a recorded outcome and the shadowed
// contents (a stored write's retention, a remote hit's frame, a local hit's
// entry). And the fidelity check compares the shadow after every step with
// the model's private predictions in every history that still carries them;
// that check, not a classifier, is what a composition of this profile
// re-encodes against its new private layout.

// conformance_observations.values: the outcome codes of successValues in order.
const outcomeCodes = [1, 2, 5, 6, 7, 8, 9];
const SOURCE_ERROR = 3;
const DEFAULT_RETENTION_MS = 5000;
const independent = overlay => overlay >= 10 && overlay < 20;

// The publication policy a provider reply carries (the model's localTtl,
// remoteTtl, retention and shared values): the overlay code and the provider
// fault switch decide it. Codes 10..19 repeat 0..9 with coalescing disabled;
// 20..25 are the invalid overlays.
function effectivePolicy(overlay, providerFailed) {
  const base = overlay < 20 ? overlay % 10 : 0;
  const localTtl = providerFailed || overlay === 20 || overlay === 21 || [3, 5, 8].includes(base) ? 0 : base === 1 ? 2000 : 1000;
  const remoteTtl = providerFailed || overlay === 20 || overlay === 22 || [4, 6, 8].includes(base) ? 0 : base === 2 ? 2000 : base === 9 ? 4000 : 1000;
  const retention = overlay === 23 || overlay === 24 ? 1000 : base === 7 ? 2000 : base === 9 ? 4000 : DEFAULT_RETENTION_MS;
  return { base, localTtl, remoteTtl, retention, shared: !independent(overlay) && (localTtl > 0 || remoteTtl > 0) };
}

// The shadow keeps the elapsed clock (now) and the wall clock, the overlay and
// how many times it changed (epoch), the fault switches, the pending caller
// (its key and index in o.calls), the single local slot, one Redis frame per
// key, every started source with the policy it captured, the overlay and
// epoch it was started under, and its result (0 while pending), and the
// receipt of the latest release: the caller, its key, which layer served it
// (or that it started a source, or joined) and the local slot of its key as
// the release found it. The receipt is read only by the fidelity check.
const NOT_SERVED = 0, FROM_LOCAL = 2, FROM_REMOTE = 3, STARTED = 4;
const initialShadow = () => ({ now: 0, wall: 100000, overlay: 0, epoch: 0, providerFailed: false, readFailed: false, dumpFailed: false, writeFailed: false,
  key: 0, call: -1, local: { key: 0, value: 0, expires: 0 }, remote: [{ value: 0, created: 0, expires: 0 }, { value: 0, created: 0, expires: 0 }], sources: [],
  receipt: { caller: -1, key: -1, layer: NOT_SERVED, localValue: 0, localExpires: 0 } });

// One frame per transition: the recorded action, the asserted observation
// before and after it, the shadow before and after it, the effective policy
// before it and the decoded input: for a released reply the receipt read from
// the observation (the caller's result and which effect counters grew), for a
// settlement the loader, its source record before settling and the settled
// value, for a seed the seeded key. A recorded outcome the shadowed contents
// cannot explain is a contradiction and throws.
function shadowHistory(steps, path) {
  const contradiction = (index, message) => new Error(`${path} step ${index}: ${message}`);
  let shadow = initialShadow();
  const frames = [];
  for (let index = 1; index < steps.length; index++) {
    const { action, choice, expected: current } = steps[index], prior = steps[index - 1].expected;
    const before = shadow, after = { ...shadow, remote: [...shadow.remote], sources: [...shadow.sources] };
    const policy = effectivePolicy(before.overlay, before.providerFailed);
    let receipt, settlement, seeded;
    switch (action) {
      case "beginCall": after.key = choice; after.call = current.calls.length - 1; break;
      case "releasePolicy": {
        if (before.call < 0) throw contradiction(index, "released a policy reply without a pending caller");
        const key = before.key, value = current.calls[before.call];
        const read = current.reads > prior.reads, starts = current.loaders > prior.loaders, load = current.loads > prior.loads;
        receipt = { key, value, read, starts, localHit: value > 0 && !read && !starts, remoteHit: value > 0 && load && !starts };
        const remote = before.remote[key], local = before.local;
        if (receipt.remoteHit && (remote.value !== value || before.now >= remote.expires)) {
          throw contradiction(index, `remote hit of ${value} on key ${key} but the shadowed frame holds ${remote.value} until ${remote.expires} at ${before.now}`);
        }
        if (receipt.localHit && (policy.localTtl === 0 || local.key !== key || local.value !== value || before.now >= local.expires)) {
          throw contradiction(index, `local hit of ${value} on key ${key} but the shadowed slot holds ${local.value} for key ${local.key} until ${local.expires} at ${before.now} with local TTL ${policy.localTtl}`);
        }
        if (starts) after.sources.push({ key, localTtl: policy.localTtl, remoteTtl: read && !before.readFailed ? policy.remoteTtl : 0,
          retention: policy.retention, shared: policy.shared, result: 0, overlay: before.overlay, epoch: before.epoch });
        // A remote hit warms an active local layer for a full insertion TTL.
        if (receipt.remoteHit && policy.localTtl > 0) after.local = { key, value, expires: before.now + policy.localTtl };
        after.receipt = { caller: before.call, key, layer: receipt.localHit ? FROM_LOCAL : receipt.remoteHit ? FROM_REMOTE : starts ? STARTED : NOT_SERVED,
          localValue: local.key === key ? local.value : 0, localExpires: local.key === key ? local.expires : 0 };
        after.call = -1;
        break;
      }
      case "resolveLoader": case "rejectLoader": {
        const loader = action === "resolveLoader" ? Math.floor((choice - 1) / outcomeCodes.length) : choice;
        const value = action === "resolveLoader" ? outcomeCodes[(choice - 1) % outcomeCodes.length] : SOURCE_ERROR;
        const source = before.sources[loader];
        if (source === undefined || source.result !== 0) throw contradiction(index, `settles no pending source ${loader}`);
        settlement = { loader, source, value };
        after.sources[loader] = { ...source, result: value };
        if (value !== SOURCE_ERROR && source.localTtl > 0) after.local = { key: source.key, value, expires: before.now + source.localTtl };
        if (current.writes > prior.writes) {
          if (current.writeTtls.at(-1) !== source.retention) throw contradiction(index, `write with TTL ${current.writeTtls.at(-1)} but source ${loader} captured retention ${source.retention}`);
          // The observation shows the dispatched write; the write fault decides whether Redis kept it.
          if (!before.writeFailed) after.remote[source.key] = { value, created: before.wall, expires: before.now + source.retention };
        }
        break;
      }
      case "seed": seeded = Math.floor(choice / 2); after.remote[seeded] = { value: choice % 2 + 1, created: before.wall, expires: before.now + DEFAULT_RETENTION_MS }; break;
      case "policy": after.overlay = choice; if (choice !== before.overlay) after.epoch = before.epoch + 1; break;
      case "advance": after.now = before.now + choice; after.wall = before.wall + choice; break;
      case "rollbackWall": after.wall = before.wall - 1000; break;
      case "providerFault": after.providerFailed = choice === 1; break;
      case "readFault": after.readFailed = choice === 1; break;
      case "dumpFault": after.dumpFailed = choice === 1; break;
      case "writeFault": after.writeFailed = choice === 1; break;
      default: throw contradiction(index, `unknown policy action ${action}`);
    }
    frames.push({ index, action, prior, current, before, after, policy, receipt, settlement, seeded });
    shadow = after;
  }
  return frames;
}

// The shadow in the model's own field names: dialcache-policy-conformance.qnt
// composed from formal/kernel. The wall clock is now plus skew; the pending
// caller is the gate's one held entry (its policy call index is its caller
// index, every caller makes a policy call); the single local slot is the one
// non-empty per-key slot of a capacity-1 instance, whose LRU order names it;
// the frames keep their names; the process registry holds the pending shared
// source of each key; a source record carries the identity it serves, the
// local TTL it warms with (0 when the local layer was off), the retention its
// refill is written with (0 when it does not refill), and its outcome; the
// freshness a reply was read under is not a source's to keep. The receipt is
// the shadow's own, in the model's layer codes.
const KEYS = 2;
function modelView(shadow) {
  const { local } = shadow;
  const slot = value => Array.from({ length: KEYS }, (_, key) => key === local.key && local.value > 0 ? value : 0);
  const registered = key => shadow.sources.findIndex(source => source.result === 0 && source.shared && source.key === key);
  return { now: shadow.now, skew: shadow.wall - shadow.now, policy: shadow.overlay, providerFailed: shadow.providerFailed, readFailed: shadow.readFailed,
    dumpFailed: shadow.dumpFailed, writeFailed: shadow.writeFailed,
    held: shadow.call < 0 ? [] : [{ policyCall: shadow.call, caller: shadow.call, call: { instance: 0, key: shadow.key, context: 0, enabled: true, keyFailed: false } }],
    localValues: slot(local.value), localExpires: slot(local.expires), lru: [local.value > 0 ? [local.key] : []],
    remoteValues: shadow.remote.map(frame => frame.value), created: shadow.remote.map(frame => frame.created), expires: shadow.remote.map(frame => frame.expires),
    processFlights: Array.from({ length: KEYS }, (_, key) => registered(key)), receipt: shadow.receipt,
    sources: shadow.sources.map(({ key, localTtl, remoteTtl, retention, shared, result }) =>
      ({ instance: 0, key, localMs: localTtl, fence: 0, retentionMs: remoteTtl > 0 ? retention : 0, result, shared })) };
}

// A history projected to its public channels carries nothing to compare; any
// other decoded state is the model's private layout and must match the shadow.
const publicChannels = ["o", "policyErrors"];
const carriesPrivateState = predictions => predictions !== undefined
  && predictions.some(state => Object.keys(state).some(field => !publicChannels.includes(field)));

// The binding between the public-only shadow and the model: the shadow after
// each step must equal the model's private predictions field by field. When
// the profile is recomposed from the kernel library, this view is re-encoded
// against the new private layout; the classifiers do not change.
function checkFidelity(frames, predictions, path) {
  const shadows = [initialShadow(), ...frames.map(frame => frame.after)];
  for (const [index, shadow] of shadows.entries()) {
    const model = predictions[index];
    for (const [field, value] of Object.entries(modelView(shadow))) {
      if (!isDeepStrictEqual(value, model[field])) throw new Error(`${path} step ${index}: shadow ${field} ${JSON.stringify(value)} differs from the model's ${JSON.stringify(model[field])}`);
    }
  }
}

const pendingSources = shadow => shadow.sources.filter(source => source.result === 0);

// Invalid overlays, overlapping sources, joins and publications across policy
// changes, settlement order and the served layer of every hit.
function settlementWitnesses(frames, recorder) {
  for (const frame of frames) {
    recorder.step(frame.index);
    const { action, prior, current, before, receipt, settlement } = frame;
    if (action === "releasePolicy") {
      const { key, value, starts, read, localHit, remoteHit } = receipt, overlay = before.overlay;
      if (!before.providerFailed) {
        if (overlay === 20 && starts && !read) recorder.credit("invalid-read-budget-bypasses-caching");
        if (overlay === 21 && read) recorder.credit("invalid-local-ramp-preserves-remote");
        if (overlay === 22 && localHit) recorder.credit("invalid-remote-ramp-preserves-local");
        if (overlay === 25 && remoteHit) recorder.credit("invalid-shadow-preserves-serving");
      }
      if (starts) {
        for (const source of pendingSources(before)) {
          if (source.key !== key) recorder.credit("cross-key-overlap");
          else if (independent(overlay) && !before.providerFailed) recorder.credit("uncoalesced-same-key-overlap");
        }
      } else if (value === 0) {
        if (pendingSources(before).some(source => source.key === key && source.epoch < before.epoch)) recorder.credit("join-after-policy-change");
      } else {
        if (remoteHit) { recorder.credit("remote-hit"); recorder.credit(`remote-value:${value}`); }
        if (localHit) { recorder.credit("local-hit"); recorder.credit(`local-value:${value}`); }
      }
    }
    if (action === "resolveLoader" || action === "rejectLoader") {
      const { loader, source } = settlement;
      if (before.sources.some((other, index) => index < loader && other.result === 0)) recorder.credit("reverse-source-settlement");
      if (prior.calls.filter((call, index) => call === 0 && current.calls[index] !== 0).length > 1) recorder.credit("coalesced-result");
      if (current.writes > prior.writes) {
        if ([23, 24].includes(source.overlay) && current.writeTtls.at(-1) === 1000) recorder.credit(`invalid-recovery-retention:${source.overlay}`);
        if (source.epoch < before.epoch) recorder.credit("publication-after-policy-change");
        if (before.call >= 0 && current.calls[before.call] === 0) recorder.credit("publication-during-policy-fetch");
      }
    }
    for (const ttl of current.writeTtls) recorder.credit(`ttl:${ttl}`);
  }
}

// The two clocks against the shadowed cache contents: a local hit keeps the
// insertion expiry it was stored with, a wall rollback neither extends the
// local entry nor lets a frame created after the rolled-back wall serve.
function clockWitnesses(frames, recorder) {
  let rolledLocal, hitBeforeExpiry;
  for (const frame of frames) {
    recorder.step(frame.index);
    const { action, before, policy, receipt } = frame;
    if (action === "rollbackWall" && before.local.value > 0) rolledLocal = { key: before.local.key, expires: before.local.expires };
    if (action !== "releasePolicy") continue;
    const { key, starts, read, localHit } = receipt, missed = read || starts;
    const { now, local } = before, active = policy.localTtl > 0;
    const sameEntry = active && local.key === key && local.value > 0;
    // The probe occurs after the original expiry but before even the shortest
    // permitted TTL could expire if the preceding hit had renewed it.
    if (sameEntry && hitBeforeExpiry?.key === key && hitBeforeExpiry.value === local.value && hitBeforeExpiry.expires === local.expires &&
      now >= local.expires && now < hitBeforeExpiry.at + 1000 && missed) recorder.credit("local-hit-preserves-insertion-expiry");
    // On a local hit the shadow already vouches for the entry: an active local
    // layer, the caller's key and value, and an insertion expiry still ahead.
    if (localHit) hitBeforeExpiry = { key, value: local.value, expires: local.expires, at: now };
    if (active && rolledLocal?.key === key && local.key === key && local.expires === rolledLocal.expires) {
      if (localHit) recorder.credit("rollback-preserves-live-local");
      if (now >= rolledLocal.expires && missed) recorder.credit("rollback-does-not-extend-local-ttl");
    }
    // Frames are stamped with the wall and only a rollback lowers it, so a
    // frame created after the observed wall is one a rollback left in the future.
    const remote = before.remote[key];
    if (!before.readFailed && remote.value > 0 && now < remote.expires && remote.created > before.wall && read && starts) {
      recorder.credit("rollback-rejects-future-remote");
    }
  }
}

// Layer interplay across the shadowed cache contents: bypassed and failed
// reads that leave or warm the local entry, remote freshness against physical
// retention, and which overlapping independent source a later hit probes.
function layerWitnesses(frames, recorder) {
  const overlaps = new Set();
  const previousPublication = new Map();
  const lastWriter = new Map();
  const bypassed = new Map();
  const warmed = new Map();
  const failedReadSources = new Set();
  const failedReadValues = new Map();
  for (const frame of frames) {
    recorder.step(frame.index);
    const { action, prior, current, before, after, policy, receipt, settlement, seeded } = frame;
    if (action === "releasePolicy") {
      const { key, value, starts, read, localHit, remoteHit } = receipt, remote = before.remote[key], local = before.local;
      if (starts) {
        const loader = after.sources.length - 1;
        for (const [other, source] of before.sources.entries()) {
          if (source.key !== key || source.result !== 0) continue;
          if (!source.shared && !after.sources[loader].shared) overlaps.add(`${Math.min(other, loader)}:${Math.max(other, loader)}`);
          if (policy.base === 8 && source.localTtl === 0 && source.remoteTtl === 0 && !read) recorder.credit("inactive-layers-independent-sources");
        }
        if (before.readFailed && read && after.sources[loader].localTtl > 0) failedReadSources.add(loader);
        if (local.key === key && local.value > 0 && before.now < local.expires) {
          if (before.providerFailed) bypassed.set(key, { value: local.value, expires: local.expires, loader, settled: false, reason: "provider-failure" });
          else if (policy.base === 8) bypassed.set(key, { value: local.value, expires: local.expires, loader, settled: false, reason: "serving-disabled" });
        }
      }
      if (!before.providerFailed) {
        if (policy.base === 5 && read && remoteHit) recorder.credit("invalid-local-ttl-preserves-remote-hit");
        if (policy.base === 6 && localHit) recorder.credit("invalid-remote-ttl-preserves-local-hit");
        if (before.overlay === 21 && remoteHit) recorder.credit("invalid-local-ramp-preserves-remote-hit");
        if (before.overlay === 22 && localHit) recorder.credit("invalid-remote-ramp-preserves-local-hit");
        if (before.overlay === 0 && localHit) recorder.credit("sparse-empty-provider-inherits-local-hit");
        if (before.overlay === 0 && remoteHit) recorder.credit("sparse-empty-provider-inherits-remote-hit");
      }
      if (localHit) {
        if (independent(before.overlay)) recorder.credit("uncoalesced-local-settled-hit");
        const retained = bypassed.get(key);
        if (retained?.settled === true && retained.value === value && retained.expires === local.expires) recorder.credit(`${retained.reason}-preserves-existing-local`);
        if (failedReadValues.get(key) === value) recorder.credit("failed-untracked-read-still-warms-local");
        const insertion = warmed.get(key);
        if (insertion?.value === value && insertion.expires === local.expires && before.wall >= insertion.freshUntil) {
          recorder.credit("remote-hit-local-ttl-outlives-remote-freshness");
        }
        if (lastWriter.get(`local:${key}`)?.value === value) recorder.credit("independent-local-last-completion-probed");
      }
      if (remoteHit) {
        // Remote warming replaces the local entry, even when the decoded value
        // is equal. It cannot count as a probe of an earlier local publication.
        lastWriter.delete(`local:${key}`);
        bypassed.delete(key);
        failedReadValues.delete(key);
        if (independent(before.overlay)) recorder.credit("uncoalesced-remote-settled-hit");
        if (lastWriter.get(`remote:${key}`)?.value === value) recorder.credit("independent-remote-last-completion-probed");
        const age = before.wall - remote.created;
        if (age >= 1000 && policy.remoteTtl > 1000) recorder.credit("increased-fresh-ttl-reuses-retained-frame");
        if (policy.localTtl > 0 && age > 0) warmed.set(key, { value, expires: after.local.expires, freshUntil: remote.created + policy.remoteTtl });
      }
      // A frame Redis still retains was read and missed: at exactly the fresh
      // boundary, or fresh under a larger TTL after physical retention ended.
      if (starts && read && !before.readFailed && remote.value > 0 && policy.remoteTtl > 0) {
        const age = before.wall - remote.created;
        if (before.now < remote.expires && age === policy.remoteTtl) recorder.credit("remote-exact-fresh-boundary-miss");
        if (before.now >= remote.expires && age >= 0 && age < policy.remoteTtl) recorder.credit("increased-fresh-ttl-cannot-resurrect-expired-storage");
      }
    }
    if (action === "resolveLoader") {
      const { loader, source, value } = settlement;
      for (const kind of ["local", "remote"]) {
        const published = kind === "local" ? source.localTtl > 0 : current.writes > prior.writes && !before.writeFailed;
        if (!published) continue;
        const key = `${kind}:${source.key}`, preceding = previousPublication.get(key);
        lastWriter.delete(key);
        if (!source.shared && preceding !== undefined && preceding.value !== value &&
          overlaps.has(`${Math.min(preceding.loader, loader)}:${Math.max(preceding.loader, loader)}`)) {
          lastWriter.set(key, { loader, value, kind });
        }
        previousPublication.set(key, { loader, value, kind });
      }
      warmed.delete(source.key);
      if (failedReadSources.has(loader) && current.dumps === prior.dumps && current.writes === prior.writes) failedReadValues.set(source.key, value);
      else if (source.localTtl > 0) failedReadValues.delete(source.key);
      // A bypassed result must differ from the retained value; otherwise a later
      // hit would not distinguish preserving the entry from replacing it.
      const bypass = bypassed.get(source.key);
      if (source.localTtl > 0 || bypass?.value === value) bypassed.delete(source.key);
      else if (bypass?.loader === loader && current.dumps === prior.dumps && current.writes === prior.writes) {
        bypassed.set(source.key, { ...bypass, settled: true });
      }
    }
    if (action === "rejectLoader" && bypassed.get(settlement.source.key)?.loader === settlement.loader) bypassed.delete(settlement.source.key);
    if (action === "seed") lastWriter.delete(`remote:${seeded}`);
  }
}

export function policyWitnesses(histories, recorder = createWitnessRecorder()) {
  actionLabels(histories, recorder);
  for (const { path, steps, predictions } of histories) {
    recorder.enter(path);
    const frames = shadowHistory(steps, path);
    if (carriesPrivateState(predictions)) checkFidelity(frames, predictions, path);
    settlementWitnesses(frames, recorder);
    clockWitnesses(frames, recorder);
    layerWitnesses(frames, recorder);
  }
  return recorder.labels();
}
