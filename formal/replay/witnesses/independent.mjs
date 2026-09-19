import { isDeepStrictEqual } from "node:util";
import { actionLabels } from "./labels.mjs";
import { createWitnessRecorder } from "./recorder.mjs";
import { profiles } from "../features.mjs";

// The independent witnesses are decided from the recorded inputs, the asserted
// observation o and the asserted read IO channel alone; no rule reads the
// model's private state. What a rule needs beyond those deltas is shadowed
// here from the inputs: the elapsed clock, the read budget and recovery age
// each caller captured at beginCall, which read, source and decode belong to
// which caller (one read per call; a source starts at the read reply, read
// deadline or failed fresh decode of its caller; a decode starts at the read
// reply, rejection or expiry of its caller's source), and each source's
// deadline. The shadow delivers due deadlines the way the model does, in time
// order and registration order for equal instants, including sources a read
// deadline starts inside the same advance. A recorded outcome the shadowed
// schedule forbids (a deadline error ahead of its deadline, a recovery outcome
// on a fresh decode, a settlement of an expired source that changes the
// observation) is a contradiction and throws. The fidelity check compares the
// shadow after every step with the model's private predictions in every
// history that still carries them: the composed profile's layout (its flights,
// held reads and decodes, loader ordinals, snapshots, deadlines and drained
// flags) is read back into the shadow's fields wherever the layout carries
// them, so a shadow that drifts from the model is refused, not credited.
//
// The labels that read private fields before this rewrite are redefined
// around public checkpoints with the same consequence:
// - independent-read-overlap, one-read-times-out-before-another: a read is
//   active from its beginCall until its reply or its entry in io.aborted.
// - late-read-does-not-affect-other-call: the replied read is one io.aborted
//   already lists, and o is unchanged (the shadow throws otherwise).
// - late-source-does-not-affect-other-call: the settled source is past its
//   shadowed deadline, and o is unchanged (the shadow throws otherwise).
// - refill-authority-is-per-call: a write at a settlement while another
//   shadowed source is still running for a caller whose read failed or timed
//   out (the model's canWrite is exactly that read outcome).
// - acquired-recovery-survives-invalidation, acquired-fresh-decode-survives-
//   invalidation: o.invalidations grew between the caller's read reply and its
//   served recovery or fresh decode. Before the read, readability required the
//   frame to be stamped after the watermark, so only an invalidation after the
//   read moves the watermark to or past the acquired stamp; the watermark
//   comparison and this checkpoint are the same fact.
// - distinct-retained-recovery-values: two served recoveries (o.recovery grew
//   by "served") completed their callers with different results.
// - independent-recovery-age-boundary: the missing caller's captured recovery
//   age differs from that of another still-pending caller; both ages are the
//   policy inputs in force at each beginCall.
// - failed-recovery-keeps-source-error: a failed recovery decode (o.recovery
//   grew by "deserialization_error") completed its caller with the source
//   error and io.sourceErrors names the caller's shadowed source.
const independent = profiles.independent;
const SOURCE_BUDGET_MS = independent.fixture.fallbackTimeoutMs;
const INITIAL_READ_BUDGET_MS = independent.fixture.readTimeoutMs;
const INITIAL_MAX_AGE_MS = independent.fixture.policy.staleOnErrorMaxAgeSec * 1000;
if (![SOURCE_BUDGET_MS, INITIAL_READ_BUDGET_MS, INITIAL_MAX_AGE_MS].every(Number.isInteger)) throw new Error("The independent profile must declare numeric read, fallback and recovery budgets");
// The policy input decoded as the driver decodes it; the two read budgets a
// history can record are its even and odd choices.
const policyInput = choice => independent.actions.policy.input(choice).value;
const READ_BUDGETS = [...new Set(independent.actions.policy.choices.map(choice => policyInput(choice).remoteReadTimeoutMs))];

const CALL_PENDING = 0, SOURCE_ERROR = 3, DEADLINE_ERROR = 4;
const settled = value => value === 1 || value === 2;
// The shadow's phase and source encodings (the former model's), for the fidelity check.
const READ_PENDING = 1, SOURCE_RUNNING = 2, FRESH_DECODE = 3, RECOVERY_DECODE = 4, CALL_DONE = 5, NO_SOURCE = -1;

// Independent-call witnesses over the shadowed schedule; the source-budget
// rule below keeps its own minimal shadow and its own crediting.
export function independentWitnesses(histories, recorder = createWitnessRecorder()) {
  actionLabels(histories, recorder);
  for (const { path, steps, predictions } of histories) {
    recorder.enter(path);
    independentSourceDeadlineWitnesses(path, steps, recorder);
    const frames = shadowHistory(steps, path);
    if (carriesPrivateState(predictions)) checkFidelity(frames, predictions, path);
    callWitnesses(frames, recorder);
  }
  return recorder.labels();
}

// The shadow keeps the elapsed clock, the read budget and recovery age the
// next caller captures, and per caller, read, source, decode and timer the
// fields the model keeps for them that the inputs and public deltas decide:
// never a frame, a candidate or a fence.
const initialShadow = () => ({ now: 0, readBudget: INITIAL_READ_BUDGET_MS, maxAge: INITIAL_MAX_AGE_MS, calls: [], reads: [], sources: [], loads: [], timers: [] });

// One frame per transition: the recorded action, the asserted observation and
// IO before and after it, the shadow before and after it, and the receipt of
// the transition decoded from the deltas: for a read reply its caller and
// whether the read was late, started a source or a fresh decode; for a
// settlement its source, caller and whether the source had expired; for a
// decode release its caller, whether it was a recovery and its outcome; for an
// advance the reads it aborted and the sources it expired.
function shadowHistory(steps, path) {
  const contradiction = (index, message) => new Error(`${path} step ${index}: ${message}`);
  let shadow = initialShadow();
  const frames = [];
  for (let index = 1; index < steps.length; index++) {
    const { action, choice, expected: current, io } = steps[index], { expected: prior, io: priorIo } = steps[index - 1];
    const before = shadow, after = structuredClone(shadow);
    const expect = (condition, message) => { if (!condition) throw contradiction(index, message); };
    const started = current.loaders - prior.loaders, loaded = current.loads - prior.loads;
    const finished = prior.calls.flatMap((result, caller) => result === CALL_PENDING && current.calls[caller] !== CALL_PENDING ? [caller] : []);
    const outcomes = current.recovery.slice(prior.recovery.length), aborted = io.aborted.slice(priorIo.aborted.length);
    // What the shadowed schedule says this step did; compared with the deltas below.
    const predicted = { starts: 0, loads: 0, classifications: 0, aborted: [], outcomes: [], finished: new Map() };
    const startSource = (caller, at) => {
      Object.assign(after.calls[caller], { phase: SOURCE_RUNNING, source: after.sources.length });
      after.timers.push({ read: false, index: after.sources.length, at: at + SOURCE_BUDGET_MS });
      after.sources.push({ caller, pending: true, active: true, startedAt: at, settledAt: -1, outcome: CALL_PENDING });
      predicted.starts++;
    };
    const startLoad = (caller, recovery) => {
      after.calls[caller].phase = recovery ? RECOVERY_DECODE : FRESH_DECODE;
      after.loads.push({ caller, pending: true, recovery });
      predicted.loads++;
    };
    const finish = (caller, accepts) => { after.calls[caller].phase = CALL_DONE; predicted.finished.set(caller, accepts); };
    // A source failure or deadline: the caller completes with the error unless
    // its read left it a recovery candidate, in which case a still-pending
    // result is the recovery decode and a completed one a miss.
    const reject = (caller, error) => {
      const call = after.calls[caller];
      call.error = error;
      if (call.canRecover) predicted.classifications++;
      if (!call.canRecover) finish(caller, value => value === error);
      else if (current.calls[caller] === CALL_PENDING) startLoad(caller, true);
      else { predicted.outcomes.push("miss"); finish(caller, value => value === error); }
    };
    let receipt;
    expect(current.calls.length === prior.calls.length + (action === "beginCall" ? 1 : 0), "changed the number of callers outside beginCall");
    switch (action) {
      case "beginCall": {
        const caller = before.calls.length;
        expect(current.calls[caller] === CALL_PENDING && io.budgets.length === current.calls.length, `caller ${caller} began without a pending result and one read budget`);
        expect(io.budgets.at(-1) === before.readBudget, `read budget ${io.budgets.at(-1)} but the policy shadow holds ${before.readBudget}`);
        after.calls.push({ source: NO_SOURCE, phase: READ_PENDING, maxAge: before.maxAge, canRecover: false, canWrite: false, error: SOURCE_ERROR });
        after.timers.push({ read: true, index: caller, at: before.now + before.readBudget });
        after.reads.push({ caller, pending: true, active: true });
        receipt = { caller };
        break;
      }
      case "releaseRead": case "failRead": {
        const failed = action === "failRead", read = after.reads[choice];
        expect(read?.pending === true, `replies to no pending read ${choice}`);
        read.pending = false;
        const caller = read.caller;
        if (!read.active) {
          expect(isDeepStrictEqual(current, prior), `late read ${choice} changed the observation`);
          receipt = { caller, late: true };
          break;
        }
        read.active = false;
        after.calls[caller].canWrite = !failed;
        if (started === 1 && loaded === 0) { after.calls[caller].canRecover = !failed; startSource(caller, before.now); receipt = { caller, late: false, starts: true }; }
        else if (!failed && started === 0 && loaded === 1) { after.calls[caller].canRecover = false; startLoad(caller, false); receipt = { caller, late: false, decodes: true }; }
        else throw contradiction(index, `active read ${choice} replied without starting caller ${caller}'s source or fresh decode`);
        break;
      }
      case "resolveLoader": case "rejectLoader": {
        const { loader, value = SOURCE_ERROR } = independent.actions[action].input(choice);
        const source = after.sources[loader];
        expect(source?.pending === true, `settles no pending source ${loader}`);
        source.pending = false;
        const caller = source.caller;
        if (!source.active) {
          expect(isDeepStrictEqual(current, prior), `settles expired source ${loader} but the observation changed`);
          receipt = { loader, caller, late: true, value };
          break;
        }
        Object.assign(source, { active: false, settledAt: before.now, outcome: value });
        const call = after.calls[caller];
        if (value === SOURCE_ERROR) reject(caller, SOURCE_ERROR);
        else {
          if (current.writes > prior.writes) {
            expect(call.canWrite, `caller ${caller} refilled after its read failed or timed out`);
            expect(current.writeTtls.at(-1) === call.maxAge, `write with TTL ${current.writeTtls.at(-1)} but caller ${caller} captured ${call.maxAge}`);
          }
          finish(caller, result => result === value);
        }
        receipt = { loader, caller, late: false, value };
        break;
      }
      case "releaseLoad": case "failLoad": {
        const failed = action === "failLoad", load = after.loads[choice];
        expect(load?.pending === true, `releases no pending decode ${choice}`);
        load.pending = false;
        const caller = load.caller;
        if (!load.recovery) {
          if (failed) { after.calls[caller].canRecover = false; startSource(caller, before.now); }
          else finish(caller, settled);
          receipt = { load: choice, caller, recovery: false };
          break;
        }
        const [outcome] = outcomes;
        expect(outcomes.length === 1 && (failed ? outcome === "deserialization_error" : outcome === "served" || outcome === "miss"),
          `recovery decode ${choice} of caller ${caller} recorded ${JSON.stringify(outcomes)}`);
        predicted.outcomes.push(outcome);
        finish(caller, outcome === "served" ? settled : result => result === after.calls[caller].error);
        receipt = { load: choice, caller, recovery: true, outcome };
        break;
      }
      case "advance": {
        // Visit each due instant in order; deliver every timer due at it in
        // registration order. A source a read deadline starts is due later.
        const target = before.now + choice, expired = [];
        const live = timer => timer.read ? after.reads[timer.index].active : after.sources[timer.index].active;
        for (let now = before.now; ;) {
          const due = after.timers.filter(timer => live(timer) && timer.at > now && timer.at <= target).map(timer => timer.at);
          if (due.length === 0) break;
          now = Math.min(...due);
          for (const timer of [...after.timers]) {
            if (timer.at !== now || !live(timer)) continue;
            if (timer.read) {
              after.reads[timer.index].active = false;
              predicted.aborted.push(timer.index);
              startSource(after.reads[timer.index].caller, now);
            } else {
              Object.assign(after.sources[timer.index], { active: false, settledAt: now, outcome: DEADLINE_ERROR });
              expired.push(timer.index);
              reject(after.sources[timer.index].caller, DEADLINE_ERROR);
            }
          }
        }
        after.now = target;
        receipt = { aborted: predicted.aborted, expired };
        break;
      }
      case "policy": {
        const { remoteReadTimeoutMs, staleOnErrorMaxAgeSec } = policyInput(choice);
        after.readBudget = remoteReadTimeoutMs; after.maxAge = staleOnErrorMaxAgeSec * 1000;
        break;
      }
      case "invalidate": expect(current.invalidations === prior.invalidations + 1, "invalidated without recording the invalidation"); break;
      case "seed": break;
      default: throw contradiction(index, `unknown independent action ${action}`);
    }
    // Bind the shadowed transition to the public deltas.
    expect(started === predicted.starts, `${started} sources started but the shadowed schedule starts ${predicted.starts}`);
    expect(loaded === predicted.loads, `${loaded} decodes started but the shadowed schedule starts ${predicted.loads}`);
    expect(isDeepStrictEqual(aborted, predicted.aborted), `aborted reads ${JSON.stringify(aborted)} but the shadowed read deadlines abort ${JSON.stringify(predicted.aborted)}`);
    expect(isDeepStrictEqual(outcomes, predicted.outcomes), `recovery outcomes ${JSON.stringify(outcomes)} but the shadowed schedule records ${JSON.stringify(predicted.outcomes)}`);
    for (const caller of finished) {
      const accepts = predicted.finished.get(caller), result = current.calls[caller];
      if (accepts === undefined) {
        const deadline = after.sources[after.calls[caller].source]?.startedAt + SOURCE_BUDGET_MS;
        if (result === DEADLINE_ERROR && deadline > after.now) throw contradiction(index, `caller ${caller} deadline ${deadline} after now ${after.now}`);
        throw contradiction(index, `caller ${caller} completed with ${result} outside the shadowed schedule`);
      }
      expect(accepts(result), `caller ${caller} completed with ${result}, not the shadowed outcome`);
    }
    for (const caller of predicted.finished.keys()) expect(finished.includes(caller), `caller ${caller} should have completed but stays ${current.calls[caller]}`);
    expect(current.classifications - prior.classifications === predicted.classifications, `${current.classifications - prior.classifications} classifications but the shadowed schedule records ${predicted.classifications}`);
    frames.push({ index, action, choice, prior, current, io, before, after, receipt });
    shadow = after;
  }
  return frames;
}

// A history projected to its public channels carries nothing to compare; any
// other decoded state is the model's private layout and must agree with the
// shadow on every field the shadow keeps that the layout carries. The layout
// is the composed profile's (dialcache-independent-conformance.qnt over the
// kernel library): a caller's flight is owners[caller], a held read or decode
// names its flight, loaders maps the drivers' ordinal to its flight, retained
// holds the pending snapshots and deadlines the pending due instants. Held
// records are pending-only, so the shadow's per-caller history is read back
// where the layout still holds it: a read's activity and a loader's owner,
// drain and outcome always; a decode's owner and kind while it is held; a
// loader's start while its deadline is pending; a caller's maximum while its
// read is held, its snapshot retained or its refill authorized; its recovery
// flag while it is pending; its refill authority once a loader has started;
// its error while it decodes a candidate. The instant a loader settled, a
// decode's value and a candidate's stamps and fence are not compared.
const publicChannels = ["o", "io"];
const carriesPrivateState = predictions => predictions !== undefined
  && predictions.some(state => Object.keys(state).some(field => !publicChannels.includes(field)));
const NO_OWNER = -1, READ_DEADLINE = 0, SOURCE_DEADLINE = 1;
const layoutFields = ["o", "now", "readBudget", "ttls", "owners", "sources", "reads", "loads", "loaders", "retained", "deadlines", "drained"];
// The shadow's fields derived from one private layout state. A field the
// layout does not carry at this step is left out and not compared.
function modelView(state, context) {
  for (const field of layoutFields) if (!Object.hasOwn(state, field)) throw new Error(`${context}: private layout is missing ${field}`);
  const { o, owners, sources, reads, loads, loaders, retained, deadlines, drained } = state;
  const ownerOf = flight => flight < 0 ? NO_OWNER : owners.indexOf(flight);
  const latestLoader = flight => loaders.reduce((latest, candidate, ordinal) => candidate === flight ? ordinal : latest, NO_SOURCE);
  const calls = o.calls.map((result, caller) => {
    const flight = owners[caller];
    if (!(flight >= 0)) throw new Error(`${context}: caller ${caller} owns no flight`);
    const source = latestLoader(flight), load = loads.find(held => held.flight === flight), snapshot = retained.find(held => held.flight === flight);
    const read = reads.find(held => held.flight === flight), authority = sources[flight];
    const phase = result !== CALL_PENDING ? CALL_DONE : load !== undefined ? (load.recovery ? RECOVERY_DECODE : FRESH_DECODE) : source >= 0 ? SOURCE_RUNNING : READ_PENDING;
    return { source, phase,
      ...(read !== undefined ? { maxAge: read.ttls.retentionMs } : snapshot !== undefined ? { maxAge: snapshot.maximum } : authority.retentionMs > 0 ? { maxAge: authority.retentionMs } : {}),
      ...(result === CALL_PENDING ? { canRecover: snapshot !== undefined } : {}),
      ...(source >= 0 ? { canWrite: authority.retentionMs > 0 } : {}),
      ...(phase === RECOVERY_DECODE ? { error: snapshot.error } : {}) };
  });
  const readViews = Array.from({ length: o.reads }, (_, index) => {
    const held = reads.find(read => read.read === index);
    return { caller: held !== undefined && held.flight >= 0 ? ownerOf(held.flight) : index, pending: held !== undefined, active: held !== undefined && held.flight !== NO_OWNER };
  });
  const loadViews = Array.from({ length: o.loads }, (_, index) => {
    const held = loads.find(load => load.load === index);
    return held === undefined ? { pending: false } : { caller: ownerOf(held.flight), pending: true, recovery: held.recovery };
  });
  const sourceViews = loaders.map((flight, ordinal) => {
    const due = deadlines.find(deadline => deadline.kind === SOURCE_DEADLINE && deadline.index === ordinal);
    return { caller: ownerOf(flight), pending: !drained[ordinal], active: sources[flight].result === CALL_PENDING, outcome: sources[flight].result,
      ...(due !== undefined ? { startedAt: due.at - SOURCE_BUDGET_MS } : {}) };
  });
  const timers = deadlines.map(deadline => ({ read: deadline.kind === READ_DEADLINE, index: deadline.index, at: deadline.at }));
  return { now: state.now, readBudget: state.readBudget, maxAge: state.ttls.retentionMs, calls, reads: readViews, loads: loadViews, sources: sourceViews, timers };
}
// The shadow projected to the fields the layout carries at this step: each
// list entry keeps the keys of the model's view of it; the timers are the
// live ones (a delivered or settled timer is no pending deadline).
function shadowView(shadow, model) {
  const project = (records, views) => records.map((record, index) => Object.fromEntries(Object.keys(views[index] ?? {}).map(key => [key, record[key]])));
  const live = timer => timer.read ? shadow.reads[timer.index].active : shadow.sources[timer.index].active;
  return { now: shadow.now, readBudget: shadow.readBudget, maxAge: shadow.maxAge, calls: project(shadow.calls, model.calls),
    reads: shadow.reads, loads: project(shadow.loads, model.loads), sources: project(shadow.sources, model.sources), timers: shadow.timers.filter(live) };
}

function checkFidelity(frames, predictions, path) {
  const shadows = [initialShadow(), ...frames.map(frame => frame.after)];
  for (const [index, shadow] of shadows.entries()) {
    const model = modelView(predictions[index], `${path} step ${index}`);
    for (const [field, value] of Object.entries(shadowView(shadow, model))) {
      if (!isDeepStrictEqual(value, model[field])) throw new Error(`${path} step ${index}: shadow ${field} ${JSON.stringify(value)} differs from the model's ${JSON.stringify(model[field])}`);
    }
  }
}

// Per-call cancellation, late effects, refill authority, acquired snapshots
// across invalidation, captured recovery age and original error identities,
// from the frames' receipts and the public deltas.
function callWitnesses(frames, recorder) {
  const invalidationsAtRead = new Map(), recovered = new Map();
  for (const frame of frames) {
    recorder.step(frame.index);
    const { action, prior, current, io, before, after, receipt } = frame;
    if (new Set(io.sourceErrors.filter(id => id > 0)).size >= 2) recorder.credit("independent-source-error-identities");
    if (READ_BUDGETS.every(budget => io.budgets.includes(budget))) recorder.credit("independent-read-budgets");
    for (const outcome of current.recovery) recorder.credit(`recovery:${outcome}`);
    if (current.calls.includes(DEADLINE_ERROR)) recorder.credit("source-deadline");
    const activeReads = after.reads.filter(read => read.active).length;
    if (action === "beginCall" && activeReads > 1) recorder.credit("independent-read-overlap");
    if (action === "advance" && receipt.aborted.length > 0 && current.calls.includes(CALL_PENDING) && activeReads > 0) recorder.credit("one-read-times-out-before-another");
    if (action === "releaseRead" || action === "failRead") {
      if (receipt.late && prior.calls.includes(CALL_PENDING)) recorder.credit("late-read-does-not-affect-other-call");
      if (!receipt.late && action === "releaseRead") invalidationsAtRead.set(receipt.caller, current.invalidations);
    }
    if (action === "resolveLoader" || action === "rejectLoader") {
      if (receipt.late && prior.calls.includes(CALL_PENDING)) recorder.credit("late-source-does-not-affect-other-call");
      if (current.writes > prior.writes && before.sources.some(source => source.active && !before.calls[source.caller].canWrite)) recorder.credit("refill-authority-is-per-call");
    }
    if (action === "releaseLoad" || action === "failLoad") {
      const { caller, recovery, outcome } = receipt, call = before.calls[caller];
      const invalidatedSinceRead = invalidationsAtRead.has(caller) && current.invalidations > invalidationsAtRead.get(caller);
      if (!recovery) {
        if (action === "releaseLoad" && invalidatedSinceRead) recorder.credit("acquired-fresh-decode-survives-invalidation");
        continue;
      }
      if (action === "failLoad" && current.calls[caller] === SOURCE_ERROR && io.sourceErrors[caller] === call.source + 1) recorder.credit("failed-recovery-keeps-source-error");
      if (outcome === "served") {
        recovered.set(caller, current.calls[caller]);
        if (new Set(recovered.values()).size === 2) recorder.credit("distinct-retained-recovery-values");
        if (invalidatedSinceRead) recorder.credit("acquired-recovery-survives-invalidation");
      }
      if (outcome === "miss" && before.calls.some((other, index) => index !== caller && other.maxAge !== call.maxAge && prior.calls[index] === CALL_PENDING)) {
        recorder.credit("independent-recovery-age-boundary");
      }
    }
  }
}

// Independent source budgets. The shadow keeps the clock (the sum of advance
// choices) and attributes every source start to its caller from public deltas:
// a read reply (releaseRead/failRead k) whose o.loaders grows starts caller k's
// source now; an advance starts one source per newly aborted read at that
// read's beginCall time plus its budget; a failed fresh decode (failLoad j)
// starts the load owner's source, loads being attributed at the read reply or
// rejectLoader that produced them. Any other growth leaves the history
// unattributable and it earns neither label. A caller's result moving 0 -> 4 is
// its last source expiring at startedAt + SOURCE_BUDGET_MS; a 4 recorded ahead
// of that instant contradicts the shadowed clock. The delivery is exact when
// the step is the advance crossing the instant; a 4 surfacing later, after a
// recovery decode, is recorded but not exact.
// later-source-survives-earlier-deadline: B's source, started after A's and
// inside A's budget, settles a value after A's deadline was delivered.
// later-source-expires-at-own-deadline: such a B expires exactly at its own
// later deadline after A expired at an earlier step. Two deadlines in one
// advance, or sources started at one instant, credit neither label.
export function independentSourceDeadlineWitnesses(path, steps, recorder) {
  let now = 0;
  const beginNow = [], budgets = [], sources = [], loads = [], expired = new Map(), survives = [], ownDeadline = [];
  const staggered = (earlier, source) => earlier.startedAt < source.startedAt && source.startedAt < earlier.deadline;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i], prior = steps[i - 1];
    const { action, choice, expected: current, io } = step, previous = prior.expected;
    const started = current.loaders - previous.loaders, loaded = current.loads - previous.loads;
    if (action === "beginCall") {
      // One read per call: the read index is the caller index.
      if (io.budgets.length !== current.calls.length) return;
      beginNow.push(now); budgets.push(io.budgets.at(-1));
    }
    if (action === "advance") {
      const aborted = io.aborted.slice(prior.io.aborted.length);
      if (started !== aborted.length) return;
      for (const read of aborted) sources.push({ caller: read, startedAt: beginNow[read] + budgets[read] });
      for (let k = 0; k < loaded; k++) loads.push({ caller: undefined });
      now += choice;
    } else if (action === "releaseRead" || action === "failRead") {
      if (started > 1 || loaded > 1) return;
      if (started === 1) sources.push({ caller: choice, startedAt: now });
      if (loaded === 1) loads.push({ caller: choice });
    } else if (action === "rejectLoader") {
      if (started > 0 || loaded > 1) return;
      if (loaded === 1) loads.push({ caller: sources[choice]?.caller });
    } else if (action === "failLoad") {
      if (started > 1 || loaded > 0) return;
      if (started === 1) {
        const caller = loads[choice]?.caller;
        if (caller === undefined) return;
        sources.push({ caller, startedAt: now });
      }
    } else if (started > 0 || loaded > 0) return;
    for (let caller = 0; caller < previous.calls.length; caller++) {
      if (previous.calls[caller] !== 0) continue;
      const result = current.calls[caller];
      if (result === DEADLINE_ERROR) {
        const source = sources.findLast(candidate => candidate.caller === caller);
        if (source === undefined) return;
        const deadline = source.startedAt + SOURCE_BUDGET_MS;
        if (now < deadline) throw new Error(`${path} step ${i}: caller ${caller} deadline ${deadline} after now ${now}`);
        const exact = action === "advance" && now - choice < deadline;
        if (exact) for (const earlier of expired.values()) if (staggered(earlier, source) && earlier.step < i) ownDeadline.push(i);
        expired.set(caller, { startedAt: source.startedAt, deadline, step: i });
      } else if (settled(result) && action === "resolveLoader") {
        const source = sources[Math.floor((choice - 1) / 2)];
        if (source === undefined || source.caller !== caller) return;
        for (const earlier of expired.values()) if (staggered(earlier, source) && earlier.step < i && now >= earlier.deadline) survives.push(i);
      }
    }
  }
  if (survives.length) recorder.credit("later-source-survives-earlier-deadline", ...new Set(survives));
  if (ownDeadline.length) recorder.credit("later-source-expires-at-own-deadline", ...new Set(ownDeadline));
}
