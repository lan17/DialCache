import { createWitnessRecorder } from "./recorder.mjs";
import { fidelityBinding } from "./fidelity.mjs";

// The effects witnesses are decided from the recorded inputs and the asserted
// observation alone (the counters, caller codes, events, read contexts, read
// aborts and write TTLs the version-2 contract asserts); no rule reads the
// model's private state. What a rule needs beyond the observation deltas is
// shadowed here from the inputs: both clocks (the fixture's origin, tick and
// jumpClock advances, wall rollbacks), the watermark invalidations raise, the
// read budget in force (the fixture's base and the runtime choices), the
// queued reply, and per loader ordinal its start, its deadline and whether it
// is running, abandoned (its deadline delivered) or settled. Which phase a
// history is in is read from the observation (a read dispatched, a decode
// held, a loader started, callers completed, a dump or a write dispatched),
// never re-decided.
//
// The labels that read private fields before this rewrite, and their public
// checkpoints with the same consequence:
// - reply:N, untracked-demotes-fenced-reply, normalized-*: the reply a
//   releaseRead consumed shaped the read (the step reported a miss, or held a
//   decode, and no read deadline error); the fixture's tracking is the init
//   choice; a fenced reply's class is the input.
// - normalized-fence-blocks-publication / -fences-refill:N: the resolve of the
//   flight that miss started completed its callers with a value and dispatched
//   no dump (refill was allowed: the read completed); -allows-refill:N: it
//   dispatched one.
// - follower-keeps-read-budget: a beginCall that dispatched no read while the
//   budget in force differs from the pending read's context budget.
// - abandoned-overlap: a loader whose deadline a tick delivered is unsettled
//   while another loader starts.
// - read-timeout-starts-source, read-late-settlement, abandoned-read-settles:
//   readAborts grew (at a tick, or at a late reply); a read settles that
//   readAborts already lists.
// - decode-outlives-deadline, acquired-hit-survives-invalidation,
//   successful-read-has-no-late-cancel: the shadow clocks at the read reply
//   that held the decode and at its release; the shadow watermark.
// - failed-read-no-refill, failed-decode-refills: the read that started the
//   loader failed or aborted; a failLoad preceded the loader.
// - serialize-outlives-deadline, publication-after-deadline, late-*: the
//   shadow deadline of the loader whose flight the dump or write belongs to.
// - late-rejection-does-not-repeat-error: a rejectLoader of an abandoned
//   ordinal adds no error event and completes no caller.
// - delayed-fenced-write: the wall at the dump release that dispatched the
//   write is at or below the shadow watermark at the write's release, and a
//   later read reply starts a loader.
// - dump-rechecks-fence-after-rollback: a releaseDump that dispatched no write.
//
// The fidelity check (the shared scaffold, fidelity.mjs) binds the shadow to
// the model wherever a history carries the composed layout's private
// predictions: both clocks, the watermark, the queued reply, the drained flags
// and, through the loaders' flights, the sources' recorded outcomes.

const CLOCK_STEP_MS = 10, WALL_ROLLBACK_MS = 1000, FUTURE_BUFFER_MS = 20, SOURCE_BUDGET_MS = 10;
// The read budget each fixture starts with (library 50, instance 20,
// operation 10, runtime 30, null provider 10, untracked 10), the base a
// runtime reset (choice 0) inherits, and the runtime budgets of choices 1..4.
const INITIAL_BUDGETS = [50, 20, 10, 30, 10, 10], BASE_BUDGETS = [50, 20, 10, 10, 10, 10], RUNTIME_BUDGETS = [0, 10, 20, 30, 50];
const FENCED_REPLIES = [7, 12, 16], FRAME_REPLY = 15;
const RUNNING = 0, ABANDONED = 1, SETTLED = 2;

const initialShadow = choice => ({ now: 10000, wall: 100000, watermark: 0, tracked: choice !== 5, base: BASE_BUDGETS[choice], budget: INITIAL_BUDGETS[choice],
  reply: 0, replyAt: 0, loaders: [], openRead: undefined, decodeStarted: undefined, acquiredAt: undefined, lastFailedRead: false, failedDecode: false, writeTimestamp: undefined });
const grew = (o, previous, field) => previous !== undefined && o[field] > previous[field];
const newEvents = (o, previous) => o.events.slice(previous?.events.length ?? 0);
const completedWithValue = (o, previous) => o.calls.some((value, index) => value === 1 && previous.calls[index] === 0);

// The shadow after one step: the inputs move the environment, the observation
// says what the flight did. Returns the next shadow and the facts the labels read.
function advanceShadow(before, step, previous, o) {
  const s = { ...before, loaders: before.loaders.map(loader => ({ ...loader })) };
  const events = newEvents(o, previous);
  const facts = { events };
  const loaderStarted = grew(o, previous, "loaders");
  switch (step.action) {
    case "beginCall": {
      // A leader's read is open until it settles or its deadline is delivered;
      // a follower joins while it is open under the leader's budget.
      if (grew(o, previous, "reads")) s.openRead = o.readContexts.length - 1;
      else if (s.openRead !== undefined) facts.followerBudgetDiffers = s.budget !== o.readContexts[s.openRead].timeoutMs;
      break;
    }
    case "releaseRead": case "failRead": {
      const aborted = o.readAborts.length > previous.readAborts.length;
      const alreadyAborted = previous.readAborts.includes(step.choice);
      const shaped = !aborted && !alreadyAborted && (events.some(e => e.event === "miss") || grew(o, previous, "loads"));
      if (step.action === "releaseRead") { facts.consumed = s.reply; if (shaped) facts.shapedBy = s.reply; s.reply = 0; }
      facts.aborted = aborted; facts.alreadyAborted = alreadyAborted;
      if (step.choice === s.openRead && (step.action === "releaseRead" || aborted)) s.openRead = undefined;
      if (step.action === "failRead" && step.choice === s.openRead && !alreadyAborted) s.openRead = undefined;
      if (grew(o, previous, "loads")) { s.decodeStarted = s.now; s.acquiredAt = s.wall; }
      if (loaderStarted) { s.lastFailedRead = step.action === "failRead" || aborted; s.failedDecode = false; }
      break;
    }
    case "releaseLoad": case "failLoad":
      facts.decodeStarted = s.decodeStarted; facts.acquiredAt = s.acquiredAt;
      if (step.action === "failLoad") s.failedDecode = true;
      if (loaderStarted && step.action === "failLoad") s.lastFailedRead = false;
      break;
    case "resolveLoader": case "rejectLoader": {
      const loader = s.loaders[step.choice];
      facts.loader = loader === undefined ? undefined : { ...loader };
      if (loader !== undefined) loader.state = SETTLED;
      break;
    }
    case "releaseDump": case "failDump": case "releaseWrite": case "failWrite":
      facts.running = s.loaders.find(l => l.state === RUNNING);
      if (step.action === "releaseDump" && grew(o, previous, "writes")) s.writeTimestamp = s.wall;
      if (step.action === "releaseWrite") facts.writeTimestamp = s.writeTimestamp;
      break;
    case "tick": {
      // A tick delivers a due loader deadline: its flight completes with a
      // timeout and the loader is abandoned.
      const running = s.loaders.find(l => l.state === RUNNING);
      if (running !== undefined && s.now + CLOCK_STEP_MS >= running.deadline && events.some(e => e.event === "fallback")) running.state = ABANDONED;
      // A read deadline the tick delivers aborts the open read and starts a
      // loader with refill denied.
      if (o.readAborts.length > previous.readAborts.length) { s.openRead = undefined; if (loaderStarted) { s.lastFailedRead = true; s.failedDecode = false; } }
      s.now += CLOCK_STEP_MS; s.wall += CLOCK_STEP_MS;
      break;
    }
    case "jumpClock": s.now += CLOCK_STEP_MS; s.wall += CLOCK_STEP_MS; break;
    case "rollbackWall": s.wall -= WALL_ROLLBACK_MS; break;
    case "invalidate": s.watermark = Math.max(s.watermark, s.wall); break;
    case "futureFence": s.watermark = Math.max(s.watermark, s.wall + FUTURE_BUFFER_MS); break;
    case "adapterReply": s.reply = step.choice; s.replyAt = s.wall; break;
    case "readBudgetPolicy": s.budget = step.choice === 0 ? s.base : RUNTIME_BUDGETS[step.choice]; break;
    case "seedRemote": case "observerFault": break;
    default: throw new Error(`unknown effects action ${step.action}`);
  }
  // A loader the step started runs from now under the fixed source budget;
  // a loader whose flight completed at this step without settling (a late
  // reply's deadline error at a read, a tick) is abandoned above.
  if (loaderStarted) s.loaders.push({ start: s.now, deadline: s.now + SOURCE_BUDGET_MS, state: RUNNING, failedRead: s.lastFailedRead, failedDecode: s.failedDecode, shapedBy: facts.shapedBy });
  // A loader whose result arrived after its deadline is settled by that
  // arrival; its flight completed with a timeout.
  if ((step.action === "resolveLoader" || step.action === "rejectLoader") && facts.loader?.state === RUNNING && before.now >= facts.loader.deadline) facts.late = true;
  return { shadow: s, facts };
}

// The shadow's view beside the model's, in the composed layout's fields: the
// clocks, the watermark, the queued reply (its stamp only while one is
// queued), and per loader whether it drained and whether its flight was
// abandoned (a deadline error recorded while the loader is still pending).
const { carriesPrivateState, checkFidelity } = fidelityBinding({ publicChannels: ["o", "io", "events"],
  layoutFields: ["now", "skew", "watermark", "reply", "replyAt", "drained", "sources", "loaders"],
  view: (shadow, m) => [
    { now: shadow.now, skew: shadow.wall - shadow.now, watermark: [shadow.watermark], reply: shadow.reply, replyAt: shadow.reply === 0 ? m.replyAt : shadow.replyAt,
      drained: shadow.loaders.map(l => l.state === SETTLED), abandoned: shadow.loaders.map(l => l.state === ABANDONED) },
    { now: m.now, skew: m.skew, watermark: m.watermark, reply: m.reply, replyAt: m.replyAt, drained: m.drained,
      abandoned: m.drained.map((drained, ordinal) => !drained && m.sources[m.loaders[ordinal]].result === 4) }] });

export function effectsWitnesses(traces, recorder = createWitnessRecorder()) {
  for (const trace of traces) {
    recorder.enter(trace.path);
    const fixture = trace.steps[0].choice;
    recorder.credit(`fixture:${fixture}`);
    let shadow = initialShadow(fixture);
    const shadows = [shadow];
    let budgetChanged = false, delayedWriteWasFenced = false;
    for (const [index, step] of trace.steps.entries()) {
      recorder.step(index);
      const o = step.expected, previous = trace.steps[index - 1]?.expected;
      if (step.action === "readBudgetPolicy") budgetChanged = true;
      if (!budgetChanged && previous?.readContexts.length === 0 && o.readContexts.length === 1) recorder.credit(`initial-budget:${fixture}`);
      for (const event of o.events) {
        recorder.credit(`event:${event.event}`);
        if (event.event === "error" || event.event === "miss") recorder.credit(`${event.event}:${event.detail}`);
        if (event.event === "serialization" && event.amount > 0) recorder.credit(`duration:${event.detail}`);
      }
      for (const context of o.readContexts) recorder.credit(`read-budget:${context.timeoutMs}`);
      if (index === 0) continue;
      const { shadow: next, facts } = advanceShadow(shadow, step, previous, o);
      if (step.action === "releaseRead" && facts.shapedBy > 0) {
        recorder.credit(`reply:${facts.shapedBy}`);
        if (!shadow.tracked && facts.shapedBy === 16) recorder.credit("untracked-demotes-fenced-reply");
      }
      if (step.action === "resolveLoader" && facts.loader?.state === RUNNING && !facts.late && !facts.loader.failedRead) {
        const reply = facts.loader.shapedBy;
        const fenced = reply !== undefined && shadow.tracked && FENCED_REPLIES.includes(reply);
        if (fenced && o.dumps === previous.dumps && completedWithValue(o, previous)) {
          recorder.credit("normalized-fence-blocks-publication");
          recorder.credit(`normalized-reply-fences-refill:${reply}`);
        }
        if (reply !== undefined && !fenced && o.dumps === previous.dumps + 1) recorder.credit(`normalized-reply-allows-refill:${reply}`);
        if (previous.calls.filter(value => value === 0).length > 1) recorder.credit("source-followers-share-accepted-result");
      }
      if (step.action === "beginCall" && facts.followerBudgetDiffers === true && previous.calls.includes(0)) recorder.credit("follower-keeps-read-budget");
      if (next.loaders.some(l => l.state === ABANDONED) && next.loaders.some(l => l.state === RUNNING)) recorder.credit("abandoned-overlap");
      if (step.action === "seedRemote") delayedWriteWasFenced = false;
      if (facts.aborted) {
        recorder.credit("read-timeout-starts-source");
        if (step.action !== "tick") recorder.credit("read-late-settlement");
      }
      if (step.action === "tick" && o.readAborts.length > previous.readAborts.length) recorder.credit("read-timeout-starts-source");
      if ((step.action === "releaseRead" || step.action === "failRead") && facts.alreadyAborted) recorder.credit("abandoned-read-settles");
      if (step.action === "releaseLoad" && facts.decodeStarted !== undefined) {
        if (next.now - facts.decodeStarted >= CLOCK_STEP_MS) recorder.credit("decode-outlives-deadline");
        if (next.watermark >= facts.acquiredAt) recorder.credit("acquired-hit-survives-invalidation");
        if (next.now - facts.decodeStarted >= CLOCK_STEP_MS && o.readAborts.length === previous.readAborts.length && o.loaders === previous.loaders) {
          recorder.credit("successful-read-has-no-late-cancel");
        }
      }
      if (step.action === "resolveLoader" && facts.loader?.state === RUNNING && !facts.late) {
        if (facts.loader.failedRead && !previous.calls.every((value, i) => value === o.calls[i]) && o.dumps === previous.dumps && !o.calls.includes(0)) recorder.credit("failed-read-no-refill");
        if (facts.loader.failedDecode && o.dumps > previous.dumps) recorder.credit("failed-decode-refills");
      }
      if (step.action === "releaseDump" && o.writes === previous.writes) recorder.credit("dump-rechecks-fence-after-rollback");
      if (step.action === "failDump") recorder.credit("dump-failure-preserves-value");
      if (step.action === "failWrite") recorder.credit("write-failure-preserves-value");
      if (step.action === "releaseDump" && facts.running === undefined && shadow.loaders.length && shadow.now >= shadow.loaders.at(-1).deadline) recorder.credit("serialize-outlives-deadline");
      if (step.action === "rejectLoader" && facts.loader?.state === ABANDONED &&
        o.events.filter(e => e.event === "error" && e.detail === "fallback").length === previous.events.filter(e => e.event === "error" && e.detail === "fallback").length &&
        o.calls.every((value, i) => value === previous.calls[i])) recorder.credit("late-rejection-does-not-repeat-error");
      if (step.action === "releaseWrite") {
        delayedWriteWasFenced = facts.writeTimestamp !== undefined && facts.writeTimestamp <= next.watermark;
        if (shadow.loaders.length && shadow.now >= shadow.loaders.at(-1).deadline) recorder.credit("publication-after-deadline");
      }
      if (delayedWriteWasFenced && step.action === "releaseRead" && !facts.aborted && !facts.alreadyAborted && o.loaders === previous.loaders + 1) recorder.credit("delayed-fenced-write");
      if (facts.late) {
        recorder.credit("late-settlement");
        recorder.credit(step.action === "resolveLoader" ? "late-resolve" : "late-reject");
      }
      shadow = next;
      shadows.push(shadow);
    }
    if (carriesPrivateState(trace.predictions)) checkFidelity(shadows, trace.predictions, trace.path);
  }
  return recorder.labels();
}
