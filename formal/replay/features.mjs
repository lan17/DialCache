import assert from "node:assert/strict";
import { assertSubset } from "./validation.mjs";
import { assertObservation } from "./divergence.mjs";
import { emptyObservation } from "./observation.mjs";
import { assertInputMetadata, itfInteger, itfSignedInteger, record } from "./itf.mjs";
import { recoveryReadProfile } from "./profiles/recovery-read.mjs";
import { localFailureProfile } from "./profiles/local-failure.mjs";
import { runtimeBoundariesProfile } from "./profiles/runtime-boundaries.mjs";
import { shadowLayersProfile } from "./profiles/shadow-layers.mjs";
import { sourceBudgetsProfile } from "./profiles/source-budgets.mjs";
import { shadowReadDeadlinesProfile } from "./profiles/shadow-read-deadlines.mjs";
import { darkLayersProfile } from "./profiles/dark-layers.mjs";
const rejectLatest = { input: (_, o) => ({ op: "reject", loader: o.loaders - 1 }) };
// Portable success codes reserve 0/3/4 for pending/source-error/deadline.
export const successValues = [1, 2, undefined, null, false, 0, ""];
const resolveValue = (maxSources) => ({
  choices: Array.from({ length: maxSources * successValues.length }, (_, i) => i + 1),
  input: (choice) => {
    const value = successValues[(choice - 1) % successValues.length];
    return { op: "resolve", loader: Math.floor((choice - 1) / successValues.length), ...(value === undefined ? {} : { value }) };
  },
});
const effectCounts = { read: "reads", load: "loads", dump: "dumps", write: "writes", policy: "policyCalls" };
const release = (effect) => ({
  input: (_, o) => ({ op: "release", effect, index: o[effectCounts[effect]] - 1 }),
});
const fault = (field) => ({
  choices: [0, 1], input: (choice) => ({ op: "faults", value: { [field]: choice === 1 } }),
});
const advance = (choices) => ({ choices, input: (choice) => ({ op: "advance", ms: choice }) });
const overlays = [
  {}, { ttlSec: { local: 2 } }, { ttlSec: { remote: 2 } }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ttlSec: { local: -1 } }, { ttlSec: { remote: -1 } },
  { staleOnErrorMaxAgeSec: 2 }, { ramp: { local: 0, remote: 0 } },
  { ttlSec: { remote: 4 }, staleOnErrorMaxAgeSec: 0 },
];
const policyOverlays = overlays.concat(overlays.map((overlay) => ({ ...overlay, coalesce: false })), [
  { remoteReadTimeoutMs: 0 }, { ramp: { local: 101 } }, { ramp: { remote: 101 } },
  { staleOnErrorMaxAgeSec: 1 }, { staleOnErrorMaxAgeSec: -1 }, { shadow: { ramp: 101 } },
]);
const layerPolicies = [{}, { requestLocal: false }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ramp: { local: 0, remote: 0 } }, { requestLocal: false, ramp: { local: 0, remote: 0 } }];
// The shadow profile's default logging inputs by init fixture, and its
// runtime logging overlays by logPolicy choice (choices 6 and 7 are the first
// two rows of the shorthand table, choices 11 and 12 write one leaf off;
// "invalid" has the wrong type for any leaf).
const shadowDefaultLogging = (choice) => (choice >= 4 && choice < 8) || choice === 13 ? { logMismatches: true }
  : choice === 14 ? { mismatchLogging: { diff: "paths" } } : choice === 15 ? { mismatchLogging: { value: false } } : {};
const shadowLogOverlays = [
  { logMismatches: false }, { logMismatches: true }, { logMismatches: "invalid" },
  { mismatchLogging: { diff: "paths" } }, { mismatchLogging: { diff: "values" } },
  { logMismatches: false, mismatchLogging: { value: true } }, { logMismatches: true, mismatchLogging: { value: false } },
  { logMismatches: false, mismatchLogging: { diff: "paths" } }, { mismatchLogging: { value: true, diff: "invalid" } },
  { mismatchLogging: { value: "invalid", diff: "paths" } }, { logMismatches: "invalid", mismatchLogging: { diff: "values" } },
  { mismatchLogging: { diff: "off" } }, { mismatchLogging: { value: false } },
];
// Choice 12 settles the source with the driver's value that has no JSON
// rendering (D13); the caller observes it as { unrenderable: true }.
const UNRENDERABLE = 12;
const shadowResolve = {
  choices: [1, 2, UNRENDERABLE],
  input: (choice, o) => choice === UNRENDERABLE ? { op: "resolve", loader: o.loaders - 1, unrenderable: true }
    : { op: "resolve", loader: o.loaders - 1, value: choice },
};
const shadowSeed = { choices: [1, 2, 3, 4, 5, 6, 7, 8], input: (choice) => choice <= 2
    ? { op: "seed", value: choice } : choice === 7 ? { op: "seed", payloadText: JSON.stringify("café") }
    : choice === 8 ? { op: "seed", payloadHex: "22636166c3a922" } : choice === 6 ? { op: "seed", payloadText: " 1" }
      : { op: "seed", payloadHex: choice === 3 ? "31" : choice === 4 ? "32" : "2031" } };
export const profiles = {
  "dark-layers": darkLayersProfile,
  "shadow-read-deadlines": shadowReadDeadlinesProfile,
  "source-budgets": sourceBudgetsProfile,
  "runtime-boundaries": runtimeBoundariesProfile,
  "shadow-layers": shadowLayersProfile,
  "local-failure": localFailureProfile,
  "recovery-read": recoveryReadProfile,
  independent: {
    explicitInputs: true,
    readIO: true,
    fixture: { policy: { ttlSec: { remote: 1 }, staleOnErrorMaxAgeSec: 5, coalesce: false },
      tracked: true, readTimeoutMs: 5, fallbackTimeoutMs: 10, recovery: "allow", observe: ["readContext", "readAbort"] },
    setup: [{ op: "seed", value: 1, ageMs: 1000 }, { op: "faults", value: { holdReads: true, holdLoads: true } }],
    actions: {
      beginCall: { input: () => ({ op: "begin" }) },
      ...Object.fromEntries(["read", "load"].flatMap(effect => [false, true].map(fail => [`${fail ? "fail" : "release"}${effect === "read" ? "Read" : "Load"}`, {
          choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "release", effect, index: choice, fail }),
        }]))),
      resolveLoader: { choices: Array.from({ length: 12 }, (_, i) => i + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: [0, 1, 2, 3, 4, 5], input: choice => ({ op: "reject", loader: choice }) },
      advance: advance([1, 5, 10, 1000]),
      seed: { choices: [0, 1, 2, 3, 4, 5], input: choice => ({ op: "seed", value: choice === 2 || choice === 4 ? 2 : 1,
          ageMs: choice === 0 || choice === 4 ? 0 : choice === 3 ? 4999 : choice === 5 ? 1999 : 1000 }) },
      invalidate: { input: () => ({ op: "invalidate" }) },
      policy: { choices: [0, 1, 2, 3], input: choice => ({ op: "policy", value: {
            remoteReadTimeoutMs: choice % 2 === 0 ? 5 : 10, staleOnErrorMaxAgeSec: choice < 2 ? 5 : 2
          } }) },
    },
  },
  layers: {
    explicitInputs: true,
    initChoices: [0, 1, 2, 3, 4, 5],
    fixture: (choice) => ({ policy: { requestLocal: true, ttlSec: { local: 60, remote: 60 } },
      tracked: choice % 2 === 1, remote: choice < 4, localMaxSize: choice === 2 || choice === 3 ? 0 : 2, fallbackTimeoutMs: null }),
    setup: [0, 1, 2].map(scope => ({ op: "openScope", id: String(scope), instance: scope === 2 ? "1" : "0" })),
    actions: {
      beginCall: { choices: Array.from({ length: 20 }, (_, i) => i), input: (choice) => {
          const context = Math.floor(choice / 4);
          const identity = choice % 4;
          return { op: "begin", key: String(Math.floor(identity / 2)), useCase: `Layers${identity % 2}`,
            ...(context < 3 ? { scope: String(context) } : { instance: context === 4 ? "1" : "0" }) };
        } },
      resolveLoader: { choices: Array.from({ length: 40 }, (_, i) => i + 1),
        input: (choice) => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: Array.from({ length: 20 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      closeScope: { choices: [0, 1, 2], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      policy: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "policy", value: layerPolicies[choice] }) },
      seed: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "seed",
          key: String(Math.floor(choice / 4)), useCase: `Layers${Math.floor(choice / 2) % 2}`, value: choice % 2 + 1 }) },
      invalidate: { choices: [0, 1], input: (choice) => ({ op: "invalidate", key: String(choice) }) },
      tick: { input: () => ({ op: "advance", ms: 1 }) },
    },
  },
  admission: {
    explicitInputs: true,
    fixture: { policy: { ttlSec: { remote: 60 }, shadow: { ramp: 100 } }, tracked: true,
      shadowMaxInFlight: 2, readTimeoutMs: 1000, probeSourceScope: true },
    setup: [0, 1, 2].map((key) => ({ op: "seed", key: String(key), value: 1 }))
      .concat([{ op: "faults", value: { holdReads: true, holdLoads: true } }]),
    actions: {
      beginCall: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "begin",
          key: String(choice % 3), instance: String(Math.floor(choice / 3)) }) },
      releaseRead: { choices: Array.from({ length: 32 }, (_, i) => i), input: (choice) => ({ op: "release", effect: "read", index: choice }) },
      releaseLoad: { choices: Array.from({ length: 32 }, (_, i) => i), input: (choice) => ({ op: "release", effect: "load", index: choice }) },
      resolveLoader: { choices: Array.from({ length: 32 }, (_, i) => i + 1),
        input: (choice) => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
      rejectLoader: { choices: Array.from({ length: 16 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      seed: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "seed", key: String(Math.floor(choice / 2)), value: choice % 2 + 1 }) },
      advance: advance([1, 10]),
      policy: { choices: [0, 1, 2, 3], input: (choice) => ({ op: "policy",
          value: { shadow: { ramp: choice % 2 === 0 ? 100 : 0 }, coalesce: choice < 2 } }) },
    },
  },
  scope: {
    explicitInputs: true,
    diagnosticAge: "none",
    fixture: { policy: { requestLocal: true }, remote: false, fallbackTimeoutMs: null, probeSourceScope: true, observe: ["coalesced", "error"] },
    setup: [{ op: "openScope", id: "0" }, { op: "faults", value: { holdPolicies: true } }],
    actions: {
      openScope: { choices: [1, 2, 3, 4], input: (choice) => ({ op: "openScope", id: String(choice),
          ...(choice === 1 ? {} : { parent: choice === 4 ? "3" : "0" }), ...(choice === 3 ? { disabled: true } : {}) }) },
      closeScope: { choices: [0, 1, 2, 3, 4], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      beginCall: { choices: [0, 1, 2, 3, 4, 5], input: (choice) => ({ op: "begin",
          ...(choice === 5 ? { outside: true } : { scope: String(choice) }) }) },
      releasePolicy: release("policy"),
      resolveLoader: resolveValue(16),
      rejectLoader: { choices: Array.from({ length: 16 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      policy: { choices: [0, 1, 2], input: (choice) => ({ op: "policy",
          value: choice === 0 ? {} : choice === 1 ? { requestLocal: false } : { coalesce: false } }) },
    },
  },
  recovery: {
    explicitInputs: true,
    diagnosticAge: "recoveryAge",
    initChoices: Array.from({ length: 8 }, (_, i) => i),
    fixture: (choice) => ({ policy: { ttlSec: { remote: 1 }, staleOnErrorMaxAgeSec: 5, requestLocal: choice >= 4 }, tracked: true, fallbackTimeoutMs: 10,
      recovery: ["default", "allow", "deny", "error"][choice % 4], observe: ["recoveryAge", "coalesced", "error"] }),
    setup: [{ op: "openScope", id: "0" }, { op: "openScope", id: "1" }, { op: "seed", value: 1, ageMs: 1000 }, { op: "faults", value: { holdLoads: true } }],
    actions: {
      beginCall: { choices: Array.from({ length: 8 }, (_, i) => i), input: (choice) => ({ op: "begin", scope: String(Math.floor(choice / 4)), ...(choice % 4 === 3 ? {} : { recovery: ["allow", "deny", "error"][choice % 4] }) }) },
      joinCall: { choices: [0, 1], input: (choice) => ({ op: "begin", scope: String(choice) }) },
      closeScope: { choices: [0, 1], input: (choice) => ({ op: "closeScope", id: String(choice) }) },
      resolveLoader: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "resolve", loader: choice, value: 2 }) },
      rejectLoader: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "reject", loader: choice }) },
      rejectTimeout: { choices: [0, 1, 2, 3, 4, 5, 6, 7], input: (choice) => ({ op: "reject", loader: choice, error: "timeout" }) },
      releaseLoad: release("load"),
      seed: { choices: [0, 1, 2, 3, 4, 5, 6], input: (choice) => ({ op: "seed", value: choice === 6 ? 2 : 1,
          ageMs: [0, 999, 1000, 4999, 5000, -1, 1000][choice] }) },
      advance: advance([1, 10, 1000, 4000]), rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) }, invalidate: { input: () => ({ op: "invalidate" }) },
      policy: { choices: [2000, 5000], input: (choice) => ({ op: "policy", value: { staleOnErrorMaxAgeSec: choice / 1000 } }) },
      readFault: fault("read"), loadFault: fault("load"),
    },
  },
  policy: {
    explicitInputs: true,
    policyErrorIO: true,
    fixture: { policy: { ttlSec: { local: 1, remote: 1 }, staleOnErrorMaxAgeSec: 5 }, localMaxSize: 1, fallbackTimeoutMs: null, observe: ["error"] },
    setup: [{ op: "faults", value: { holdPolicies: true } }],
    actions: {
      beginCall: { choices: [0, 1], input: (choice) => ({ op: "begin", key: String(choice) }) },
      releasePolicy: release("policy"),
      resolveLoader: resolveValue(12),
      rejectLoader: { choices: Array.from({ length: 12 }, (_, i) => i), input: (choice) => ({ op: "reject", loader: choice }) },
      seed: { choices: [0, 1, 2, 3], input: (choice) => ({ op: "seed", key: String(Math.floor(choice / 2)), value: choice % 2 + 1, ttlMs: 5000 }) },
      policy: { choices: policyOverlays.map((_, i) => i), input: (choice) => ({ op: "policy", value: policyOverlays[choice] }) },
      advance: advance([1, 500, 1000, 2000, 5000]), rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) }, providerFault: fault("policy"),
      readFault: fault("read"), dumpFault: fault("dump"), writeFault: fault("write"),
    },
  },
  shadow: {
    explicitInputs: true, diagnosticFutureOffsets: true, diagnosticWarnings: true,
    diagnosticAge: "shadowAge", diagnosticConfigErrors: true, initChoices: Array.from({ length: 16 }, (_, i) => i),
    fixture: (choice) => ({ policy: { ttlSec: { remote: 60 }, ramp: { remote: 0 },
        shadow: { ramp: 100, ...shadowDefaultLogging(choice) } }, tracked: true, shadowHook: choice !== 8,
      ...(choice % 4 === 0 || choice >= 11 ? {} : { comparator: ["equal", "unequal", "error"][choice === 10 ? 2 : choice % 4 - 1] }),
      ...(choice === 9 || choice === 10 ? { comparisonMs: 10 } : {}),
      ...(choice === 11 || choice === 12 ? { sourceWorkMs: choice === 11 ? 9 : 10 } : {}),
      ...(choice === 13 ? { mismatchDiff: "error" } : {}),
      observe: ["shadowAge", "mismatchWarning", "shadowMismatchLogging", "coalesced", "error", "futureOffset"] }),
    setup: [{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }],
    actions: {
      beginCall: { input: () => ({ op: "begin" }) }, resolveLoader: shadowResolve, rejectLoader: rejectLatest,
      releaseRead: release("read"), releaseLoad: release("load"), releaseDump: release("dump"), releaseWrite: release("write"),
      advance: advance([1, 10]), seed: shadowSeed, reencode: shadowSeed,
      seedUnicode: { ...shadowSeed, choices: [7, 8] },
      invalidate: { choices: [0, 20], input: (choice) => ({ op: "invalidate", futureBufferMs: choice }) },
      readFault: fault("read"), loadFault: fault("load"), dumpFault: fault("dump"), writeFault: fault("write"), loggerFault: fault("logger"),
      rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) },
      advanceWall: { choices: [1, 60000], input: choice => ({ op: "shiftWall", ms: choice }) },
      shadowPolicy: { choices: [0, 1, 2], input: (choice) => ({ op: "policy", value: { shadow: { ramp: [100, 0, 101][choice] } } }) },
      logPolicy: { choices: shadowLogOverlays.map((_, i) => i), input: (choice) => ({ op: "policy", value: { shadow: shadowLogOverlays[choice] } }) },
    },
  },
};
function observation(raw, context) {
  const value = record(raw, context);
  const shape = { ...emptyObservation(), calls: [] };
  if (Object.keys(value).sort().join() !== Object.keys(shape).sort().join())
    throw new Error(`${context}: unexpected observation fields`);
  const result = Object.fromEntries(Object.entries(shape).map(([key, initial]) => {
    const item = value[key];
    if (typeof initial === "number")
      return [key, itfInteger(item, context)];
    if (!Array.isArray(item))
      throw new Error(`${context}: expected ${key} list`);
    return [key, item.map((entry) => {
        if (key === "calls" || key === "writeTtls") {
          const integer = itfInteger(entry, context);
          if (key === "calls" && (integer < 0 || integer > 9 && integer !== 11 && integer !== UNRENDERABLE))
            throw new Error(`${context}: unsupported caller outcome`);
          return integer;
        }
        if (typeof entry !== (key === "sourceScopes" ? "boolean" : "string"))
          throw new Error(`${context}: invalid ${key} entry`);
        return entry;
      })];
  }));
  return result;
}
// The warning content lists a profile asserts only with diagnosticWarnings. A
// profile whose drivers never log a mismatch may carry them, empty, or not at
// all (a trace generated before they existed), so the differential compares
// it across both texts.
const warningContentFields = ["loggingOutcomes", "mismatchWarnings"];
function diagnostics(raw, context, configErrors = false, futureOffsets = false, inspect = false, warningContent = false) {
  const value = record(raw, context);
  const fields = ["ages", "coalesced", "fallbackErrors", "warnings", ...(configErrors ? ["configErrors"] : []), ...(futureOffsets ? ["futureOffsets"] : []),
    ...(inspect ? ["inspections"] : []), ...(warningContent ? warningContentFields : [])];
  const carried = Object.keys(value).filter(key => warningContent || !warningContentFields.includes(key) || !Array.isArray(value[key]) || value[key].length > 0);
  if (carried.sort().join() !== fields.sort().join() || !Array.isArray(value.ages))
    throw new Error(`${context}: invalid diagnostics`);
  const labels = (items, allowed) => {
    if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !allowed.includes(item)))
      throw new Error(`${context}: invalid diagnostic labels`);
    return items;
  };
  const offsets = futureOffsets ? (() => {
    if (!Array.isArray(value.futureOffsets))
      throw new Error(`${context}: missing future offsets`);
    return value.futureOffsets.map(raw => {
      const offset = record(raw, context);
      if (Object.keys(offset).sort().join() !== "layer,offsetMs" || offset.layer !== "remote_shadow")
        throw new Error(`${context}: invalid future offset layer`);
      const offsetMs = itfInteger(offset.offsetMs, context);
      if (offsetMs <= 0)
        throw new Error(`${context}: future offset must be positive`);
      return { layer: offset.layer, offsetMs };
    });
  })() : [];
  const inspections = inspect ? (() => {
    if (!Array.isArray(value.inspections)) throw new Error(`${context}: missing coalescing inspections`);
    return value.inspections.map(raw => {
      const entry = record(raw, context);
      if (Object.keys(entry).sort().join() !== "activeFollowers,activeLeaders,instance,oldestLeaderAgeMs") throw new Error(`${context}: invalid coalescing inspection`);
      const age = itfSignedInteger(entry.oldestLeaderAgeMs, context);
      if (age < -1) throw new Error(`${context}: invalid oldest leader age`);
      return { instance: itfInteger(entry.instance, context), activeLeaders: itfInteger(entry.activeLeaders, context),
        activeFollowers: itfInteger(entry.activeFollowers, context), oldestLeaderAgeMs: age === -1 ? null : age };
    });
  })() : [];
  return { ...(inspect ? { inspections } : {}), ...(futureOffsets ? { futureOffsets: offsets } : {}), ...(configErrors ? { configErrors: itfInteger(value.configErrors, context) } : {}),
    ...(warningContent ? { mismatchWarnings: mismatchWarnings(value.mismatchWarnings, context), loggingOutcomes: labels(value.loggingOutcomes, loggingOutcomes) } : {}),
    warnings: itfInteger(value.warnings, context), ages: value.ages.map(age => itfInteger(age, context) / 1000),
    coalesced: labels(value.coalesced, ["process", "request_local"]), fallbackErrors: labels(value.fallbackErrors, ["noop", "local", "remote", "request_local"]) };
}
// One confirmed-mismatch warning's content as the shadow profile predicts it
// (D12), in the record the projection builds from a driver's event: the age in
// seconds, each value field and entry side as a value code (-1 left out, 0
// null), the diff level whose fields it carries and whether they are null, the
// uncut count, the paths, the entries (at `values`) and the failure it names.
const loggingOutcomes = ["logged", "hook_error", "render_error", "logger_error"];
const warningFields = "ageMs,cachedValue,count,diff,diffNull,entries,loggingOutcome,paths,sourceValue";
function mismatchWarnings(raw, context) {
  if (!Array.isArray(raw)) throw new Error(`${context}: missing mismatch warnings`);
  return raw.map(item => {
    const warning = record(item, context);
    if (Object.keys(warning).sort().join() !== warningFields || !Array.isArray(warning.paths) || !Array.isArray(warning.entries)
      || !["off", "paths", "values"].includes(warning.diff) || typeof warning.diffNull !== "boolean"
      || !["", "hook_error", "render_error"].includes(warning.loggingOutcome) || warning.paths.some(path => typeof path !== "string"))
      throw new Error(`${context}: invalid mismatch warning`);
    return { ageSeconds: itfInteger(warning.ageMs, context) / 1000, cachedValue: itfSignedInteger(warning.cachedValue, context),
      sourceValue: itfSignedInteger(warning.sourceValue, context), diff: warning.diff, diffNull: warning.diffNull,
      count: itfInteger(warning.count, context), paths: warning.paths, entries: warning.entries.map(raw => {
        const entry = record(raw, context);
        if (Object.keys(entry).sort().join() !== "cached,path,source" || typeof entry.path !== "string")
          throw new Error(`${context}: invalid mismatch entry`);
        return { path: entry.path, cached: itfSignedInteger(entry.cached, context), source: itfSignedInteger(entry.source, context) };
      }), loggingOutcome: warning.loggingOutcome };
  });
}
function readIO(raw, context, callCount) {
  const value = record(raw, context);
  if (Object.keys(value).sort().join() !== "aborted,budgets,sourceErrors" || !Array.isArray(value.budgets) || !Array.isArray(value.aborted) || !Array.isArray(value.sourceErrors))
    throw new Error(`${context}: invalid read observations`);
  const budgets = value.budgets.map(v => itfInteger(v, context)), aborted = value.aborted.map(v => itfInteger(v, context));
  if (budgets.some(v => v <= 0) || aborted.some(v => v >= budgets.length) || new Set(aborted).size !== aborted.length)
    throw new Error(`${context}: invalid read budget or cancellation`);
  const sourceErrors = value.sourceErrors.map(v => itfInteger(v, context));
  if (sourceErrors.length !== callCount)
    throw new Error(`${context}: missing caller error identities`);
  return { budgets, aborted, sourceErrors };
}
function markerIO(raw, context) {
  if (!Array.isArray(raw))
    throw new Error(`${context}: missing marker observations`);
  return raw.map(item => {
    const marker = record(item, context);
    if (Object.keys(marker).sort().join() !== "cutoffMs,ttlMs")
      throw new Error(`${context}: invalid marker observation`);
    return { cutoffMs: itfSignedInteger(marker.cutoffMs, context), ttlMs: itfSignedInteger(marker.ttlMs, context) };
  });
}
export function parseTrace(raw, path, profile) {
  const states = record(raw, path).states;
  if (!Array.isArray(states) || states.length < 2)
    throw new Error(`${path}: expected a nonempty trace`);
  return { path, steps: states.map((rawState, i) => {
      const context = `${path} step ${i}`;
      const state = record(rawState, context);
      // Explicit inputs are recorded by the Quint transition itself, including
      // deterministic regressions where Quint emits no MBT metadata. Never infer
      // a command from differences in expected state.
      const input = record(state.input, context);
      if (Object.keys(input).sort().join() !== "choice,name") {
        throw new Error(`${context}: invalid explicit input`);
      }
      const action = input.name;
      if (typeof action !== "string" || (i === 0 ? action !== "init" : !Object.hasOwn(profile.actions, action))) {
        throw new Error(`${context}: unknown or misplaced action`);
      }
      const choices = action === "init" ? profile.initChoices : profile.actions[action]?.choices;
      const choice = itfSignedInteger(input.choice, context);
      if (choices === undefined ? choice !== -1 : !choices.includes(choice)) {
        throw new Error(`${context}: unsupported explicit choice`);
      }
      assertInputMetadata(state, action, choice, choices !== undefined, context);
      const expected = observation(record(state.s, context).o, context);
      return { action, choice, expected,
        ...(profile.policyErrorIO ? { policyErrors: policyErrors(record(state.s, context).policyErrors, context) } : {}),
        ...(profile.compressionIO ? { compression: compressionIO(record(state.s, context).compression, context) } : {}),
        ...(profile.markerIO ? { markers: markerIO(record(state.s, context).markers, context) } : {}),
        ...(profile.readIO ? { io: readIO(record(state.s, context).io, context, expected.calls.length) } : {}),
        ...(profile.diagnosticAge === undefined ? {} : { diagnostics: diagnostics(record(state.s, context).d, context, profile.diagnosticConfigErrors,
          profile.diagnosticFutureOffsets, profile.diagnosticInspections, profile.diagnosticWarnings) }) };
    }) };
}
function valueCode(value) {
  const v = value.value;
  if (v === 1 || v === 2)
    return v;
  if (v === null)
    return 6;
  if (v === false)
    return 7;
  if (v === 0)
    return 8;
  if (v === "")
    return 9;
  if (v === "undefined")
    return 11;
  if (typeof v === "object" && v.absent === true)
    return 5;
  if (typeof v === "object" && v.unrenderable === true)
    return UNRENDERABLE;
  return 10;
}
// A logged JSON value as the shadow profile's value code: its decoded values
// (`1`, `2`, `"café"` as 3) and the portable scalars.
function jsonCode(value) {
  const codes = [[1, 1], [2, 2], ["café", 3], [null, 6], [false, 7], [0, 8], ["", 9]];
  const found = codes.find(([json]) => json === value);
  assertObservedDomain(found !== undefined, { value }, { value: "a value the shadow profile logs" });
  return found[1];
}
function parsedField(text, field) {
  if (typeof text !== "string") throw new Error(`Invalid actual ${field} shape`);
  try { return JSON.parse(text); }
  catch { return assertObservedDomain(false, { [field]: text }, { [field]: "JSON text" }); }
}
// A value field or an entry side: -1 when left out, 0 when logged as null.
const sideCode = (holder, side, parse) => !Object.hasOwn(holder, side) ? -1
  : holder[side] === null && parse ? 0 : jsonCode(parse ? parsedField(holder[side], side) : holder[side]);
// A driver's mismatchWarning event as the shadow profile's warning record: the
// diff level is the most detailed diff field it carries; the paths, the count
// and diffJson are null together or not at all, and diffJson's entries carry
// the same paths as mismatchPathsJson (the comparison checks both).
function projectWarning(event) {
  const has = field => Object.hasOwn(event, field);
  if (typeof event.cachedValueAgeSeconds !== "number")
    throw new Error("Missing actual warning age");
  const diff = has("diffJson") ? "values" : has("mismatchPathsJson") ? "paths" : "off";
  const diffNull = has("mismatchPathsJson") && event.mismatchPathsJson === null;
  assertObservedDomain(has("mismatchPathsJson") === has("mismatchPathCount") && (diff !== "values" || has("mismatchPathsJson"))
    && (diff === "off" || ((event.mismatchPathCount === null) === diffNull && (diff !== "values" || (event.diffJson === null) === diffNull))),
  { mismatchPathsJson: event.mismatchPathsJson, mismatchPathCount: event.mismatchPathCount, diffJson: event.diffJson },
  { diffFields: "carried together and null together" });
  const listed = diff !== "off" && !diffNull;
  const paths = listed ? parsedField(event.mismatchPathsJson, "mismatchPathsJson") : [];
  const entries = listed && diff === "values" ? parsedField(event.diffJson, "diffJson") : [];
  assertObservedDomain(Array.isArray(paths) && paths.every(path => typeof path === "string") && Array.isArray(entries)
    && entries.every(entry => entry !== null && typeof entry === "object" && typeof entry.path === "string"
      && Object.keys(entry).every(key => ["path", "cached", "source"].includes(key)))
    && (!listed || Number.isSafeInteger(event.mismatchPathCount)),
  { mismatchPathsJson: event.mismatchPathsJson, diffJson: event.diffJson }, { diffFields: "paths, entries and an integer count" });
  return { ageSeconds: event.cachedValueAgeSeconds, cachedValue: sideCode(event, "cachedValueJson", true), sourceValue: sideCode(event, "sourceValueJson", true),
    diff, diffNull, count: listed ? event.mismatchPathCount : 0, paths,
    entries: entries.map(entry => ({ path: entry.path, cached: sideCode(entry, "cached", false), source: sideCode(entry, "source", false) })),
    loggingOutcome: event.loggingOutcome ?? "" };
}
function project(o) {
  return { ...o, calls: o.calls.map((c) => c.status === "pending" ? 0
      : c.status === "value" ? valueCode(c)
        : c.error.startsWith("source:") ? 3 : c.error.startsWith("timeout:") ? 4 : 10) };
}
// Well-shaped observations outside a declared value domain are semantic
// failures. Keep their evidence typed so the coordinator can distinguish them
// from missing fields or malformed driver records.
function assertObservedDomain(valid, actual, expected) {
  if (!valid) throw new assert.AssertionError({ actual, expected, operator: "observed value domain" });
}
export function projectObservation(profile, observed) {
  if (profile.policyErrorIO) {
    if (observed.events === undefined)
      throw new Error("Missing actual policy diagnostics");
    const selected = observed.events.filter(event => event.event === "error" && event.layer === "noop" && event.error === "config_resolution");
    for (const event of selected)
      assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id", inFallback: false });
    const { events: _events, ...base } = observed;
    return { ...projectBaseObservation(profile, base), policyErrors: selected.map(() => ({ layer: "noop", errorType: "config_resolution" })) };
  }
  if (!profile.markerIO && !profile.compressionIO)
    return projectBaseObservation(profile, observed);
  const markers = [];
  const compression = [];
  const events = observed.events?.filter(event => {
    if (profile.compressionIO && event.event === "compression") {
      assertSubset(event, { cacheNamespace: "urn", useCase: "Behavior", keyType: "id", layer: "remote" });
      if (typeof event.outcome !== "string")
        throw new Error("Invalid actual compression outcome shape");
      assertObservedDomain(event.outcome === "decompressed" || event.outcome === "fallback_raw",
        { outcome: event.outcome }, { outcome: ["decompressed", "fallback_raw"] });
      compression.push(event.outcome);
      return false;
    }
    if (!profile.markerIO || event.event !== "marker")
      return true;
    if (typeof event.cutoffMs !== "number" || typeof event.ttlMs !== "number")
      throw new Error("Invalid actual marker observation");
    markers.push({ cutoffMs: event.cutoffMs, ttlMs: event.ttlMs });
    return false;
  });
  if (events === undefined)
    throw new Error("Missing actual marker observations");
  const { events: _events, ...base } = observed;
  return { ...projectBaseObservation(profile, profile.readIO || profile.diagnosticAge !== undefined ? { ...base, events } : base),
    ...(profile.markerIO ? { markers } : {}), ...(profile.compressionIO ? { compression } : {}) };
}
function policyErrors(raw, context) {
  if (!Array.isArray(raw))
    throw new Error(`${context}: missing policy errors`);
  return raw.map(item => {
    const error = record(item, context);
    if (Object.keys(error).sort().join() !== "errorType,layer" || error.layer !== "noop" || error.errorType !== "config_resolution")
      throw new Error(`${context}: invalid policy error`);
    return { layer: error.layer, errorType: error.errorType };
  });
}
function compressionIO(raw, context) {
  if (!Array.isArray(raw) || raw.some(value => value !== "decompressed" && value !== "fallback_raw"))
    throw new Error(`${context}: invalid compression observations`);
  return raw;
}
function projectBaseObservation(profile, observed) {
  if (profile.readIO) {
    const { events, ...base } = observed;
    if (events === undefined)
      throw new Error("Missing actual read observations");
    const io = { budgets: [], aborted: [], sourceErrors: observed.calls.map(call => {
        if (call.status !== "error" || !call.error.startsWith("source:"))
          return 0;
        if (!/^source:\d+$/.test(call.error))
          throw new Error("Unknown actual source error identity");
        return Number(call.error.slice("source:".length)) + 1;
      }) };
    const diagnostics = [];
    for (const event of events) {
      if (event.event === "readContext") {
        assert.deepEqual(event.index, io.budgets.length);
        assert.deepEqual(event.aborted, false);
        if (typeof event.timeoutMs !== "number")
          throw new Error("Missing actual read budget");
        io.budgets.push(event.timeoutMs);
      }
      else if (event.event === "readAbort") {
        if (typeof event.index !== "number")
          throw new Error("Missing actual cancellation identity");
        io.aborted.push(event.index);
      }
      else if (profile.diagnosticAge !== undefined) diagnostics.push(event);
      else {
        if (typeof event.event !== "string")
          throw new Error("Missing actual read event kind");
        assertObservedDomain(false, { event: event.event }, { event: ["readContext", "readAbort"] });
      }
    }
    return { ...(profile.diagnosticAge === undefined ? { o: project(base) }
      : projectBaseObservation({ ...profile, readIO: false }, { ...base, events: diagnostics })), io };
  }
  if (profile.diagnosticAge === undefined)
    return { o: project(observed) };
  const { events, ...base } = observed;
  if (events === undefined)
    throw new Error("Missing actual diagnostic observations");
  const ages = [];
  const futureOffsets = [];
  let warnings = 0, configErrors = 0;
  const coalesced = [], fallbackErrors = [], inspections = [], mismatchWarnings = [], loggingOutcomes = [];
  const outcomes = profile.diagnosticAge === "shadowAge" ? observed.shadow.filter(x => x === "match" || x === "mismatch")
    : observed.recovery.filter(x => x === "served");
  for (const event of events) {
    if (profile.diagnosticInspections && event.event === "coalescingState") {
      if (typeof event.instance !== "string" || !/^[01]$/.test(event.instance)
          || !Number.isSafeInteger(event.activeLeaders) || event.activeLeaders < 0
          || !Number.isSafeInteger(event.activeFollowers) || event.activeFollowers < 0
          || !(event.oldestLeaderAgeMs === null || (Number.isFinite(event.oldestLeaderAgeMs) && event.oldestLeaderAgeMs >= 0)))
        throw new Error("Malformed actual coalescing inspection");
      inspections.push({ instance: Number(event.instance), activeLeaders: event.activeLeaders,
        activeFollowers: event.activeFollowers, oldestLeaderAgeMs: event.oldestLeaderAgeMs });
      continue;
    }
    // This profile selects source failures; other error trails are specified
    // by effects. Maintenance errors deliberately carry another use case.
    if (profile.diagnosticConfigErrors && event.event === "error" && event.error === "config_resolution") {
      assertSubset(event, { cacheNamespace: "urn", useCase: profile.diagnosticUseCase ?? "Behavior", keyType: "id", layer: "remote", inFallback: false });
      configErrors++;
      continue;
    }
    if (event.event === "error" && event.error !== "fallback")
      continue;
    assertSubset(event, { cacheNamespace: "urn", useCase: profile.diagnosticUseCase ?? "Behavior", keyType: "id" });
    if (event.event === "coalesced") {
      if (typeof event.scope !== "string")
        throw new Error("Missing coalescing scope");
      coalesced.push(event.scope);
    }
    else if (event.event === "error") {
      // This projection selects source failures; the effects profile compares
      // the complete cache/read/serializer error trail independently.
      if (event.error === "fallback") {
        assert.deepEqual(event.inFallback, true);
        if (typeof event.layer !== "string")
          throw new Error("Missing source failure layer");
        fallbackErrors.push(event.layer);
      }
    }
    else if (event.event === "futureOffset" && profile.diagnosticFutureOffsets) {
      if (typeof event.layer !== "string")
        throw new Error("Invalid actual future offset layer shape");
      if (typeof event.seconds !== "number")
        throw new Error("Invalid actual future offset shape");
      assert.deepEqual({ layer: event.layer }, { layer: "remote_shadow" });
      assertObservedDomain(Number.isSafeInteger(event.seconds * 1000) && event.seconds > 0,
        { seconds: event.seconds }, { seconds: "positive time in whole milliseconds" });
      futureOffsets.push({ layer: event.layer, offsetMs: event.seconds * 1000 });
    }
    else if (event.event === "mismatchWarning") {
      assert.deepEqual(event.outcome, "mismatch");
      warnings++;
      if (profile.diagnosticWarnings) mismatchWarnings.push(projectWarning(event));
    }
    else if (event.event === "shadowMismatchLogging" && profile.diagnosticWarnings) {
      if (typeof event.outcome !== "string")
        throw new Error("Invalid actual mismatch logging outcome shape");
      loggingOutcomes.push(event.outcome);
    }
    else {
      assert.deepEqual(event.event, profile.diagnosticAge);
      assert.deepEqual(event.outcome, outcomes[ages.length]);
      if (typeof event.seconds !== "number")
        throw new Error("Missing actual diagnostic age");
      ages.push(event.seconds);
    }
  }
  return { o: project(base), d: { warnings, ages, coalesced, fallbackErrors, ...(profile.diagnosticInspections ? { inspections } : {}), ...(profile.diagnosticFutureOffsets ? { futureOffsets } : {}), ...(profile.diagnosticConfigErrors ? { configErrors } : {}),
    ...(profile.diagnosticWarnings ? { mismatchWarnings, loggingOutcomes } : {}) } };
}
export function expectedObservation(step) { return { o: step.expected, ...(step.policyErrors === undefined ? {} : { policyErrors: step.policyErrors }), ...(step.diagnostics === undefined ? {} : { d: step.diagnostics }), ...(step.io === undefined ? {} : { io: step.io }), ...(step.markers === undefined ? {} : { markers: step.markers }), ...(step.compression === undefined ? {} : { compression: step.compression }) }; }
export function featureInput(profile, action, choice, observed, environment) { const binding = profile.actions[action]; if (!binding || (binding.choices ? !binding.choices.includes(choice) : choice !== -1 && choice !== 0))
  throw new Error("Unknown feature action or choice"); return binding.input(choice, observed, environment); }
export function assertFeatureObservation(profile, step, observed) { assertObservation(projectObservation(profile, observed), expectedObservation(step)); }
