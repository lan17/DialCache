import { successValues } from "../features.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// Private clock/cache predictions classify only schedules subsequently probed
// by real replay. They never enter driver inputs or implementation projection.
export function clockWitnesses(name, histories, recorder = createWitnessRecorder()) {
  for (const { path, steps, states } of histories) {
    recorder.enter(path);
    let rolledLocal;
    let hitBeforeExpiry;
    let rolled = false;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      if (i === 0) continue;
      const before = states[i - 1];
      const previous = steps[i - 1].expected;
      const o = step.expected;
      if (step.action === "rollbackWall") {
        rolled = true;
        if (name === "policy" && before.localValue > 0) rolledLocal = { key: before.localKey, expires: before.localExpires };
      }
      if (name === "policy" && step.action === "releasePolicy") {
        const key = before.key, overlay = before.overlay, base = overlay < 20 ? overlay % 10 : 0;
        const local = before.providerFailed === false && ![20, 21].includes(overlay) && ![3, 5, 8].includes(base);
        const now = before.now, expires = before.localExpires, value = before.localValue;
        const sameEntry = local && before.localKey === key && value > 0;
        // The probe occurs after the original expiry but before even the shortest
        // permitted TTL could expire if the preceding read had renewed it.
        if (sameEntry && hitBeforeExpiry?.key === key && hitBeforeExpiry.value === value &&
          hitBeforeExpiry.expires === expires && now >= expires && now < hitBeforeExpiry.at + 1000 &&
          (o.reads > previous.reads || o.loaders > previous.loaders)) recorder.credit("local-hit-preserves-insertion-expiry");
        if (sameEntry && now < expires && o.calls[before.policyCall] > 0 &&
          o.reads === previous.reads && o.loaders === previous.loaders) hitBeforeExpiry = { key, value, expires, at: now };
        if (local && rolledLocal?.key === key && before.localKey === key && before.localExpires === rolledLocal.expires) {
          const result = o.calls[before.policyCall];
          if (before.now < rolledLocal.expires && result > 0 && o.reads === previous.reads && o.loaders === previous.loaders) recorder.credit("rollback-preserves-live-local");
          if (before.now >= rolledLocal.expires && (o.reads > previous.reads || o.loaders > previous.loaders)) recorder.credit("rollback-does-not-extend-local-ttl");
        }
        if (rolled && before.readFailed === false && before.remoteValues[key] > 0 &&
          before.now < before.remoteExpires[key] && before.remoteCreated[key] > before.wall &&
          o.reads > previous.reads && o.loads === previous.loads && o.loaders > previous.loaders) recorder.credit("rollback-rejects-future-remote");
      }
      if (name === "recovery" && step.action === "releaseLoad" && before.phase === 3 && before.loadFailed === false &&
        before.wall < before.candidateCreated && o.recovery.length > previous.recovery.length && o.recovery.at(-1) === "miss") recorder.credit("rollback-rejects-retained-future");
    }
  }
  return recorder.labels();
}

export function policyWitnesses(histories, recorder = createWitnessRecorder()) {
  clockWitnesses("policy", histories, recorder);
  for (const { path, steps } of histories) {
    recorder.enter(path);
    let policyEpoch = 0;
    let overlay = 0;
    let providerFailed = false;
    let pendingPolicy = -1;
    const keys = [];
    const sources = new Map();
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      if (step.action === "beginCall") {
        keys.push(step.choice);
        pendingPolicy = o.calls.length - 1;
      }
      if (step.action === "policy") {
        if (overlay !== step.choice) policyEpoch++;
        overlay = step.choice;
      }
      if (step.action === "providerFault") providerFailed = step.choice === 1;
      if (step.action === "releasePolicy") {
        const key = keys[pendingPolicy];
        if (!providerFailed) {
          if (overlay === 20 && o.loaders > previous.loaders && o.reads === previous.reads) recorder.credit("invalid-read-budget-bypasses-caching");
          if (overlay === 21 && o.reads > previous.reads) recorder.credit("invalid-local-ramp-preserves-remote");
          if (overlay === 22 && o.calls[pendingPolicy] > 0 && o.reads === previous.reads && o.loaders === previous.loaders) recorder.credit("invalid-remote-ramp-preserves-local");
          if (overlay === 25 && o.loads > previous.loads && o.loaders === previous.loaders) recorder.credit("invalid-shadow-preserves-serving");
        }
        if (o.loaders > previous.loaders) {
          for (const source of sources.values()) {
            if (source.key !== key) recorder.credit("cross-key-overlap");
            else if (overlay >= 10 && overlay < 20 && !providerFailed) recorder.credit("uncoalesced-same-key-overlap");
          }
          sources.set(o.loaders - 1, { key, epoch: policyEpoch, overlay });
        } else if (o.calls[pendingPolicy] === 0) {
          if ([...sources.values()].some(source => source.key === key && source.epoch < policyEpoch)) {
            recorder.credit("join-after-policy-change");
          }
        } else {
          if (o.loads > previous.loads) { recorder.credit("remote-hit"); recorder.credit(`remote-value:${o.calls[pendingPolicy]}`); }
          if (o.reads === previous.reads) { recorder.credit("local-hit"); recorder.credit(`local-value:${o.calls[pendingPolicy]}`); }
        }
        pendingPolicy = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${path}: missing accepted source ${loader}`);
        if ([...sources.keys()].some(pending => pending < loader)) recorder.credit("reverse-source-settlement");
        if (previous.calls.filter((c, index) => c === 0 && o.calls[index] !== 0).length > 1) recorder.credit("coalesced-result");
        if (o.writes > previous.writes) {
          if ([23, 24].includes(source.overlay) && o.writeTtls.at(-1) === 1000) recorder.credit(`invalid-recovery-retention:${source.overlay}`);
          if (source.epoch < policyEpoch) recorder.credit("publication-after-policy-change");
          if (pendingPolicy >= 0 && o.calls[pendingPolicy] === 0) recorder.credit("publication-during-policy-fetch");
        }
        sources.delete(loader);
      }
      for (const ttl of o.writeTtls) recorder.credit(`ttl:${ttl}`);
    }
  }
  return recorder.labels();
}
