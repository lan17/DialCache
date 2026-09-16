import { successValues } from "../features.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// Request-scope witnesses over declared inputs, public observations and the
// fallback diagnostics. No private memo or scope state is consulted: the row a
// source fills is the outer lifetime of the context its caller began in (the
// input choice), a held reply is the last beginCall that counted a policy
// call, the policy overlay is the last policy input, closure is the closeScope
// input, and a source is pending until its resolve or reject input.
export function scopeWitnesses(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    const closed = new Set();
    const rejected = new Set();
    const published = new Map();
    const bypassed = new Map();
    const sources = new Map();
    const overlaps = new Set();
    const lastWriter = new Map();
    const scopes = [];
    let lateOuterSource = false;
    let valueBeforeNestedClose;
    let policyCall = -1;
    let overlay = 0;
    const holder = scope => scope === 1 ? 1 : 0;
    for (const [i, step] of steps.entries()) {
      recorder.step(i);
      recorder.credit(`action:${step.action}`);
      const o = step.expected;
      const previous = steps[i - 1]?.expected;
      if (previous === undefined) continue;
      for (const layer of step.diagnostics.fallbackErrors) recorder.credit(`failure-layer:${layer}`);
      if (step.action === "rejectLoader") {
        const failures = o.calls.filter((value, j) => value === 3 && previous.calls[j] === 0).length;
        const added = step.diagnostics.fallbackErrors.length - steps[i - 1].diagnostics.fallbackErrors.length;
        if (failures > 1 && added === 1) recorder.credit("one-error-for-request-followers");
        if (failures === 1 && added === 0) recorder.credit("pass-through-error-has-no-cache-trail");
      }
      if (step.action === "policy") overlay = step.choice;
      if (step.action === "closeScope") {
        closed.add(step.choice);
        if (step.choice === 2) valueBeforeNestedClose = published.get(0)?.value;
        if (step.choice < 2) { published.delete(step.choice); bypassed.delete(step.choice); lastWriter.delete(step.choice); }
      }
      if (step.action === "beginCall") {
        const scope = step.choice;
        scopes.push(scope);
        if (o.policyCalls > previous.policyCalls) policyCall = scopes.length - 1;
        else if (o.loaders > previous.loaders) {
          sources.set(o.loaders - 1, { scope, memoizing: false, shared: false });
          if (scope === 3) recorder.credit("disabled-bypass");
          if (scope < 5 && closed.has(holder(scope))) recorder.credit("detached-bypass");
        }
      }
      if (step.action === "releasePolicy") {
        const scope = scopes[policyCall];
        const lifetime = holder(scope);
        if (o.loaders > previous.loaders) {
          const active = o.sourceScopes.at(-1);
          const memoizing = active && overlay !== 1;
          const shared = memoizing && overlay === 0;
          const loader = o.loaders - 1;
          if (!active) recorder.credit("policy-reply-after-close");
          if (memoizing) {
            if (overlay === 0 && rejected.has(lifetime)) recorder.credit("rejected-flight-retry");
            if (scope === 1 && lateOuterSource) recorder.credit("replacement-miss-after-late-source");
            for (const [other, source] of sources) {
              if (!source.memoizing || closed.has(holder(source.scope))) continue;
              if (holder(source.scope) !== lifetime) recorder.credit("independent-scope-overlap");
              else if (overlay === 2) recorder.credit("uncoalesced-scope-overlap");
              // Two independent sources pending in one row: whichever settles
              // last writes the row, so a later probe can tell the order.
              if (holder(source.scope) === lifetime && !source.shared && !shared) overlaps.add(`${other}:${loader}`);
            }
          }
          if (active && overlay === 1 && published.has(lifetime)) bypassed.set(lifetime, published.get(lifetime).value);
          sources.set(loader, { scope, memoizing, shared });
        } else if (o.calls[policyCall] !== 0) {
          recorder.credit("memo-hit");
          recorder.credit(`memo-value:${o.calls[policyCall]}`);
          if (published.get(lifetime)?.scope !== scope) {
            if (scope === 2) recorder.credit("nested-memo-hit");
            if (scope === 4) recorder.credit("reenabled-memo-hit");
          }
          if (lifetime === 0 && valueBeforeNestedClose === o.calls[policyCall]) recorder.credit("memo-after-nested-close");
          if (bypassed.get(lifetime) === o.calls[policyCall]) recorder.credit("memo-after-policy-bypass");
          if (overlay === 2) {
            recorder.credit("uncoalesced-request-settled-hit");
            if (lastWriter.get(lifetime) === o.calls[policyCall]) recorder.credit("independent-request-last-completion-probed");
          }
        }
        policyCall = -1;
      }
      if (step.action === "resolveLoader" || step.action === "rejectLoader") {
        const loader = step.action === "resolveLoader" ? Math.floor((step.choice - 1) / successValues.length) : step.choice;
        const source = sources.get(loader);
        if (source === undefined) throw new Error(`${path}: missing source ${loader}`);
        const completed = o.calls.filter((value, index) => value !== 0 && previous.calls[index] === 0);
        const lifetime = holder(source.scope);
        if (step.action === "rejectLoader") {
          if (source.shared) rejected.add(lifetime);
          if (completed.length > 1) recorder.credit("shared-rejection");
        } else if (source.memoizing) {
          if (closed.has(lifetime)) {
            recorder.credit("source-settles-after-close");
            if (lifetime === 0) lateOuterSource = true;
          } else {
            const value = completed[0], preceding = published.get(lifetime);
            lastWriter.delete(lifetime);
            if (!source.shared && preceding !== undefined && preceding.value !== value
              && overlaps.has(`${Math.min(preceding.loader, loader)}:${Math.max(preceding.loader, loader)}`)) lastWriter.set(lifetime, value);
            published.set(lifetime, { value, scope: source.scope, loader });
            if (lifetime === 0) valueBeforeNestedClose = undefined;
            bypassed.delete(lifetime);
          }
        }
        sources.delete(loader);
      }
    }
  }
  return recorder.labels();
}
