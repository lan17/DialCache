import assert from "node:assert/strict";
import { assertSubset } from "./validation.mjs";
import { assertInputMetadata, itfInteger, itfSignedInteger, record } from "./itf.mjs";
export const actions = ["init", "beginCall", "resolveLoader", "rejectLoader", "releaseRead", "failRead", "releaseLoad", "failLoad", "releaseDump", "failDump", "releaseWrite", "failWrite", "seedRemote", "tick", "jumpClock", "rollbackWall", "advanceWall", "observerFault", "readBudgetPolicy", "adapterReply", "invalidate", "futureFence"];
export const observedFields = ["loaders", "reads", "writes", "invalidations", "loads", "dumps", "policyCalls"];
const eventNames = ["request", "disabled", "miss", "error", "coalesced", "invalidation", "get", "fallback", "serialization", "futureOffset", "size", "storedSize", "writeDispatch"];
const timedEvents = new Set(["get", "fallback", "serialization", "futureOffset"]);
// The effects caller codes of the version-2 contract (BEHAVIOR.md): 0 pending,
// 1 value 1, 2 original source error, 3 timeout. The composed text records
// the shared conformance_observations codes (3 source error, 4 deadline
// error); the projection maps them to the contract's codes, so the asserted
// record is unchanged by the composition.
const sharedToEffectsCode = { 0: 0, 1: 1, 3: 2, 4: 3 };
// The fixture's remote TTL, the retention every write carries.
const REMOTE_TTL_MS = 60000;
const chosenActions = new Set(["init", "advanceWall", "adapterReply", "readBudgetPolicy", "observerFault", "resolveLoader", "rejectLoader", "releaseRead", "failRead"]);
const wallAdvances = [1, 59999, 60000];
const choiceBounds = { init: [0, 5], readBudgetPolicy: [0, 4], observerFault: [0, 1], adapterReply: [1, 16] };

function parseEvents(raw, context) {
  if (!Array.isArray(raw)) throw new Error(`${context}: missing event observations`);
  return raw.map(value => {
    const event = record(value, context);
    if (Object.keys(event).sort().join() !== "amount,detail,event,location" || typeof event.event !== "string" ||
      !eventNames.some(name => name === event.event) || typeof event.location !== "string" || typeof event.detail !== "string") {
      throw new Error(`${context}: invalid event observation`);
    }
    const amount = itfInteger(event.amount, context);
    return { event: event.event, location: event.location, detail: event.detail, amount: timedEvents.has(event.event) ? amount / 1000 : amount };
  });
}
function integers(raw, context, name) {
  if (!Array.isArray(raw)) throw new Error(`${context}: missing ${name} list`);
  return raw.map(value => itfInteger(value, `${context} ${name}`));
}
// The expected observation of the composed layout: the shared observation
// record `o`, the read channel `io` and the events channel.
function composedExpected(rawState, context) {
  const o = record(rawState.o, context), io = record(rawState.io, context);
  const calls = integers(o.calls, context, "calls").map(code => {
    if (!Object.hasOwn(sharedToEffectsCode, code)) throw new Error(`${context}: unsupported caller outcome ${code}`);
    return sharedToEffectsCode[code];
  });
  const budgets = integers(io.budgets, context, "budgets"), aborted = integers(io.aborted, context, "aborted");
  if (budgets.some(budget => ![10, 20, 30, 50].includes(budget))) throw new Error(`${context}: unsupported read budget`);
  return {
    ...Object.fromEntries(observedFields.map(field => [field, itfInteger(o[field], `${context} ${field}`)])),
    calls, events: parseEvents(rawState.events, context), writeTtls: integers(o.writeTtls, context, "writeTtls"),
    readAborts: aborted, readContexts: budgets.map((timeoutMs, index) => ({ index, timeoutMs, aborted: false })),
  };
}
// The expected observation of the retired layout (the text before the
// composition), read from its private fields as the version-2 driver did:
// the same record, so a history of either layout is asserted identically.
// Transitional, for the corpus differential whose reference is the merge base
// with main while that base still carries the retired text: once main carries
// the composed text, delete retiredFields, retiredExpected and the layout
// branch in parseTrace (the kernel README's record row names this deletion).
const retiredFields = ["now", "wall", "readStarted", "decodeStarted", "tracked", "reply", "replyAt", "readBudget", "baseReadBudget", "phase", "activeLoader", "activeRead", "deadline", "refill", "acceptedAt", "acceptedWall", "observerFailed", "readAborts", "observedFence", "writeTimestamp", "storedTimestamp", "watermark",
  ...observedFields];
function retiredExpected(rawState, context, previous) {
  if (Object.keys(rawState).length !== retiredFields.length + 5) throw new Error(`${context}: unexpected model fields`);
  const state = Object.fromEntries(retiredFields.map(field => [field, itfInteger(rawState[field], `${context} ${field}`)]));
  const calls = integers(rawState.calls, context, "calls"), readBudgets = integers(rawState.readBudgets, context, "readBudgets");
  integers(rawState.sources, context, "sources"); integers(rawState.readStates, context, "readStates");
  if (calls.some(code => code > 3) || readBudgets.some(budget => ![10, 20, 30, 50].includes(budget))) throw new Error(`${context}: unsupported code`);
  const readAborts = previous === undefined ? [] : [...previous.readAborts, ...(state.readAborts > previous.private.readAborts ? [previous.private.activeRead] : [])];
  return { private: state, expected: {
    ...Object.fromEntries(observedFields.map(field => [field, state[field]])),
    calls, events: parseEvents(rawState.events, context), writeTtls: Array(state.writes).fill(REMOTE_TTL_MS),
    readAborts, readContexts: readBudgets.map((timeoutMs, index) => ({ index, timeoutMs, aborted: false })),
  } };
}
// A parsed history: per step the explicit input and the observation the
// drivers are asserted against, whichever layout recorded it.
export function parseTrace(value, path) {
  const states = record(value, path).states;
  if (!Array.isArray(states) || states.length < 2) throw new Error(`${path}: expected a nonempty trace`);
  let previous;
  const steps = states.map((raw, index) => {
    const context = `${path} step ${index}`;
    const step = record(raw, context);
    const input = record(step.input, context);
    if (Object.keys(input).sort().join() !== "choice,name") throw new Error(`${context}: invalid explicit input`);
    const action = input.name;
    if (!actions.some(name => name === action) || ((index === 0) !== (action === "init"))) throw new Error(`${context}: unknown or misplaced action ${JSON.stringify(action)}`);
    const chosen = chosenActions.has(action);
    const encoded = itfSignedInteger(input.choice, context);
    let choice;
    if (chosen) {
      if (encoded < 0) throw new Error(`${context}: missing effect choice`);
      choice = encoded;
      if (action === "advanceWall" && !wallAdvances.includes(choice)) throw new Error(`${context}: unsupported wall advance`);
      const bounds = choiceBounds[action];
      if (bounds && (choice < bounds[0] || choice > bounds[1])) throw new Error(`${context}: unsupported effect choice`);
    } else if (encoded !== -1) throw new Error(`${context}: unexpected effect choice`);
    assertInputMetadata(step, action, encoded, chosen, context);
    const rawState = record(step.s, context);
    let expected;
    if (Object.hasOwn(rawState, "o")) expected = composedExpected(rawState, context);
    else { const parsed = retiredExpected(rawState, context, previous); previous = { ...parsed, readAborts: parsed.expected.readAborts }; expected = parsed.expected; }
    return { action, choice: encoded, expected };
  });
  return { path, steps };
}
// The explicit-input descriptor the corpus differential replays this profile
// with: the actions and their choice domains, over the record above.
export const effectsDescriptor = { explicitInputs: true, parseTrace,
  actions: Object.fromEntries(actions.filter(name => name !== "init").map(name => [name,
    name === "advanceWall" ? { choices: wallAdvances } : chosenActions.has(name) ? { choices: choiceBounds[name] ? Array.from({ length: choiceBounds[name][1] - choiceBounds[name][0] + 1 }, (_, i) => choiceBounds[name][0] + i) : "index" } : {}])) };
// Concrete JSON encodings of the model's semantic reply classes. Timestamps
// come from the controlled external clock, never expected model state.
function adapterReply(choice, stamp) {
  const replies = [null, 42, { kind: "watermark_miss", observedWatermarkMs: stamp + 20 },
    { reason: "value_absent" }, { kind: "miss" }, { kind: "miss", reason: "invented" },
    { kind: "miss", reason: "invented", observedWatermarkMs: stamp + 20 },
    { kind: "miss", reason: "watermark_fenced" }, { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: -1 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: 1.5 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: 9007199254740992 },
    { kind: "miss", reason: "value_absent", observedWatermarkMs: stamp + 20 },
    { kind: "miss", reason: "expired", observedWatermarkMs: 0 },
    { kind: "miss", reason: "value_absent", payload: "1", createdAtMs: stamp },
    { reason: "watermark_fenced", observedWatermarkMs: stamp + 20, payload: "1", createdAtMs: stamp },
    { kind: "miss", reason: "watermark_fenced", observedWatermarkMs: stamp + 20 }];
  return replies[choice - 1];
}
export function inputsFor(step, observed, environment) {
  const release = (effect, index, failed = false) => [
    { op: "faults", value: { [effect]: failed } }, { op: "release", effect, index },
    { op: "faults", value: { [effect]: false } },
  ];
  switch (step.action) {
    case "init": return [{ op: "policy", value: step.choice === 3 ? { remoteReadTimeoutMs: 30 } : step.choice === 4 ? null : {} }];
    case "beginCall": return [{ op: "begin" }];
    case "resolveLoader": return [{ op: "resolve", loader: step.choice, value: 1 }];
    case "rejectLoader": return [{ op: "reject", loader: step.choice }];
    case "releaseRead": return release("read", step.choice);
    case "failRead": return release("read", step.choice, true);
    case "releaseLoad": return release("load", observed.loads - 1);
    case "failLoad": return release("load", observed.loads - 1, true);
    case "releaseDump": return release("dump", observed.dumps - 1);
    case "failDump": return release("dump", observed.dumps - 1, true);
    case "releaseWrite": return release("write", observed.writes - 1);
    case "failWrite": return release("write", observed.writes - 1, true);
    case "seedRemote": return [{ op: "seed", value: 1 }];
    case "tick": return [{ op: "advance", ms: 10 }];
    case "jumpClock": return [{ op: "advance", ms: 10, deliverTimers: false }];
    case "readBudgetPolicy": return [{ op: "policy", value: step.choice === 0 ? {} : { remoteReadTimeoutMs: [0, 10, 20, 30, 50][step.choice] } }];
    case "adapterReply": return [{ op: "adapterReply", value: adapterReply(step.choice, environment.wallMs) }];
    case "observerFault": return [{ op: "faults", value: { observer: step.choice === 1 } }];
    case "advanceWall": return [{ op: "shiftWall", ms: step.choice }];
    case "rollbackWall": return [{ op: "shiftWall", ms: -1000 }];
    case "invalidate": return [{ op: "invalidate" }];
    case "futureFence": return [{ op: "invalidate", futureBufferMs: 20 }];
  }
}
function projectEvents(observed) {
  return observed.events.filter(event => event.event !== "readContext" && event.event !== "readAbort").map(event => {
    if (event.event === "writeDispatch") {
      if (typeof event.index !== "number") throw new Error("Missing actual write index");
      return { event: event.event, location: "remote", detail: "", amount: event.index };
    }
    assertSubset(event, { cacheNamespace: "urn", keyType: "id" });
    if (event.event !== "invalidation") assert.deepEqual(event.useCase, "Behavior");
    if (event.event === "error") assert.deepEqual(event.inFallback, event.error === "fallback");
    const location = event.layer ?? event.scope;
    const detail = event.reason ?? event.error ?? event.operation ?? "";
    const amount = event.seconds ?? event.bytes ?? 0;
    if (typeof location !== "string" || typeof detail !== "string" || typeof amount !== "number") throw new Error("Invalid actual diagnostic observation");
    return { event: event.event, location, detail, amount };
  });
}
export function project(observed) {
  return {
    ...Object.fromEntries(observedFields.map((field) => [field, observed[field]])),
    calls: observed.calls.map((call) => call.status === "pending" ? 0
      : call.status === "value" ? (call.value === 1 ? 1 : 4)
        : call.error.startsWith("source:") ? 2 : call.error.startsWith("timeout:") ? 3 : 4),
    writeTtls: observed.writeTtls, events: projectEvents(observed),
    readContexts: observed.events.filter(event => event.event === "readContext").map(({ index, timeoutMs, aborted }) => ({ index, timeoutMs, aborted })),
    readAborts: observed.events.filter(event => event.event === "readAbort").map(event => event.index),
  };
}
export function fixtureFor(mode) {
  return { policy: { ttlSec: { remote: 60 }, ...(mode >= 2 ? { remoteReadTimeoutMs: 10 } : {}) },
    tracked: mode !== 5, readTimeoutMs: mode === 0 ? "default" : 20, observe: ["readContext", "readAbort", ...eventNames] };
}
export function expectedObservations(trace) { return trace.steps.map(step => step.expected); }
