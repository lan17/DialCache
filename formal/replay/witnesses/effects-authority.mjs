import { witnessCommand as cmd } from "./trace.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

const init = cmd("init", 2), begin = cmd("beginCall"), read = cmd("releaseRead", 0);
const resolve = cmd("resolveLoader", 0), reject = cmd("rejectLoader", 0);
const load = cmd("releaseLoad"), dump = cmd("releaseDump"), write = cmd("releaseWrite");
const fault = cmd("observerFault", 1);
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const hit = o => same(o.calls, [1]) && o.reads === 1 && o.loads === 1 && o.loaders === 0 && o.writes === 0;
const publishedAndRead = o => same(o.calls, [1, 1]) && o.reads === 2 && o.loads === 1 && o.loaders === 1 && o.dumps === 1 && o.writes === 1;

// Inputs identify a deliberately narrow distinguishing schedule. Credit then
// depends only on the observation asserted by every driver (the parsed
// history's `expected`: counters, caller codes and events in callback
// seconds); no phase, private timestamp, stored value or model authorization
// predicate enters these rules.
export const effectsAuthorityRules = [
  { name: "observer-failure-hit", regression: "observerFailuresCannotPreventCacheHitTest",
    commands: [init, fault, cmd("seedRemote"), begin, read, load], consequence: hit },
  { name: "observer-failure-publication", regression: "observerFailuresCannotPreventPublicationTest",
    commands: [init, fault, begin, read, resolve, dump, write, begin, cmd("releaseRead", 1), load], consequence: publishedAndRead },
  { name: "observer-failure-source-error", regression: "observerFailuresCannotReplaceSourceErrorTest",
    commands: [init, fault, begin, cmd("failRead", 0), reject],
    consequence: o => same(o.calls, [2]) && o.reads === 1 && o.loaders === 1 && o.loads === 0 && o.writes === 0 },
  { name: "write-stamp-after-serialization", regression: "writeStampAfterSerializationClearsInterveningFenceTest",
    commands: [init, begin, read, resolve, cmd("invalidate"), cmd("tick"), dump, write, begin, cmd("releaseRead", 1), load],
    consequence: publishedAndRead },
  { name: "future-offset-observing-layer-positive-seconds", regression: "futureFrameReportsPositiveObservingOffsetTest",
    commands: [init, cmd("seedRemote"), cmd("rollbackWall"), begin, read, reject],
    consequence: o => same(o.calls, [2]) && o.loads === 0 && o.loaders === 1 && same(
      o.events.filter(e => e.event === "futureOffset"), [{ event: "futureOffset", location: "remote", detail: "", amount: 1 }]) },
  { name: "shared-failure-preserves-leader-and-follower-trail", regression: "coalescedFailureKeepsOneLeaderAndFollowerTrailTest",
    commands: [init, begin, begin, cmd("failRead", 0), reject],
    consequence: o => same(o.calls, [2, 2]) && o.reads === 1 && o.loaders === 1 && o.loads === 0 && o.writes === 0 && same(
      o.events.filter(e => ["request", "coalesced", "error"].includes(e.event)), [
        { event: "request", location: "remote", detail: "", amount: 0 },
        { event: "coalesced", location: "process", detail: "", amount: 0 },
        { event: "error", location: "remote", detail: "cache_read", amount: 0 },
        { event: "error", location: "remote", detail: "fallback", amount: 0 },
      ]) },
];

// Over the parsed histories: the recorded inputs and the asserted observations.
export function effectsAuthorityWitnesses(histories, recorder = createWitnessRecorder()) {
  for (const { path, steps } of histories) {
    recorder.enter(path);
    const commands = steps.map(step => cmd(step.action, step.choice));
    for (const rule of effectsAuthorityRules) {
      if (commands.length >= rule.commands.length && rule.commands.every((value, index) => commands[index] === value)
        && rule.consequence(steps[rule.commands.length - 1].expected)) recorder.credit(rule.name, rule.commands.length - 1);
    }
  }
  return recorder.labels();
}
