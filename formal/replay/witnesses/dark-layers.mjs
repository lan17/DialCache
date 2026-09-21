import { publicPrefixWitnesses, publicPrefixRule as rule, publicCheckpoint as check, witnessCommand as command } from "./public-prefix.mjs";
import { decodeIntegers, explicitInput } from "./trace.mjs";
import { createWitnessRecorder } from "./recorder.mjs";

// Public commands identify the schedule; consequences at each boundary earn
// credit independently of filenames and the model's private storage.
export const darkLayersWitnessRules = [
  rule("later-dark-source-keeps-own-budget", "laterDarkSourceKeepsItsWholeBudgetTest",
    [command("init"), command("advance", 10), command("policy", 0), command("beginCall", 0), command("resolveLoader", 1), command("beginCall", 2)],
    check(4, { calls: [1], loaders: 1, reads: 1, dumps: 0, shadow: [] }, { fallbackErrors: [] }),
    check(5, { calls: [1, 1], loaders: 1, reads: 1, dumps: 0, shadow: [] }, { fallbackErrors: [] })),
  rule("rejected-dark-source-seeds-no-layer", "rejectedDarkSourceSeedsNoLayerTest",
    [command("init"), command("policy", 0), command("beginCall", 0), command("releaseRead", 0), command("rejectLoader", 0), command("beginCall", 0)],
    check(4, {"calls": [3], "shadow": ["source_error"], "loads": 0, "dumps": 0, "writes": 0}, {"fallbackErrors": ["local"]}),
    check(5, {"calls": [3, 0], "loaders": 2, "reads": 2}, {"coalesced": []})),
  rule("uncoalesced-publication-keeps-dark-leader", "uncoalescedPublicationDoesNotPreemptTheRegisteredLeaderTest",
    [command("init"), command("policy", 0), command("beginCall", 0), command("policy", 5), command("beginCall", 2), command("resolveLoader", 4), command("policy", 0), command("beginCall", 6), command("resolveLoader", 1)],
    check(4, {"calls": [0, 0], "loaders": 2, "reads": 1, "shadow": ["dropped"]}),
    check(7, {"calls": [0, 2, 0], "loaders": 2}, {"coalesced": ["process"]}),
    check(8, {"calls": [1, 2, 1], "loaders": 2})),
  rule("held-dark-fill-keeps-captured-retention", "darkFillCarriesCapturedRetentionOnTheHeldPathTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("policy", 7), command("resolveLoader", 1), command("releaseDump", 0), command("releaseWrite", 0)],
    check(5, {"calls": [1], "dumps": 1, "writes": 0}),
    check(6, {"writeTtls": [120000], "writes": 1}),
    check(7, {"shadow": ["filled"]})),
  rule("dark-fill-at-watermark-is-fenced", "fillAtTheWatermarkInstantIsFencedTest",
    [command("init"), command("invalidate", 0), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1)],
    check(5, {"calls": [1], "shadow": ["fill_fenced"], "dumps": 0})),
  rule("dark-frame-at-watermark-is-fenced", "frameAtTheWatermarkIsFencedFromTheDarkReadTest",
    [command("init"), command("invalidate", 0), command("seed", 0), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("advance", 1), command("resolveLoader", 2)],
    check(7, {"calls": [2], "dumps": 1, "loads": 0})),
  rule("held-dark-fill-rechecks-fence-after-rollback", "fillFenceIsRejudgedAfterAWallRollbackTest",
    [command("init"), command("invalidate", 0), command("advance", 1), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1), command("rollbackWall"), command("releaseDump", 0)],
    check(8, {"shadow": ["fill_fenced"], "writes": 0})),
  rule("stale-visible-dark-c0-fills-unfenced", "staleVisibleFrameDeclinedByTheDarkReadFillsUnfencedTest",
    [command("init"), command("policy", 3), command("seed", 3), command("beginCall", 0), command("releaseRead", 0), command("invalidate", 1), command("resolveLoader", 2), command("releaseDump", 0), command("releaseWrite", 0), command("beginCall", 0), command("releaseRead", 1), command("resolveLoader", 3)],
    check(8, {"writes": 1, "shadow": ["filled"]}),
    check(10, {"reads": 2}),
    check(11, {"calls": [2, 1], "shadow": ["filled", "fill_fenced"], "dumps": 1, "writes": 1})),
  rule("undecodable-held-dark-c0-is-not-repaired", "undecodableDarkC0IsNeverRepairedTest",
    [command("init"), command("policy", 3), command("seed", 4), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 2), command("releaseLoad", 0)],
    check(5, {"calls": [2], "loads": 1, "dumps": 0}),
    check(6, {"shadow": ["deserialization_error"], "dumps": 0, "reads": 1})),
  rule("unsupported-encoding-ends-dark-read", "unsupportedEncodingFailsTheDarkReadTest",
    [command("init"), command("policy", 3), command("seed", 5), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1)],
    check(4, {"shadow": ["redis_error"]}),
    check(5, {"calls": [1], "dumps": 0, "loads": 0})),
  rule("dark-source-deadline-attributed-to-local", "sourceDeadlineExpiresTheDarkJobAndAttributesToTheLocalLayerTest",
    [command("init"), command("policy", 0), command("beginCall", 0), command("advance", 10), command("releaseRead", 0), command("beginCall", 0)],
    check(3, {"calls": [4], "shadow": ["timeout"]}, {"fallbackErrors": ["local"]}),
    check(4, {"shadow": ["timeout"], "dumps": 0}),
    check(5, {"calls": [4, 0], "loaders": 2}, {"coalesced": []})),
  rule("dark-flights-are-instance-local", "sameKeyCallersOnTwoInstancesKeepSeparateFlightsTest",
    [command("init"), command("policy", 0), command("beginCall", 0), command("beginCall", 4), command("resolveLoader", 2)],
    check(3, {"calls": [0, 0], "loaders": 2, "reads": 2, "shadow": []}, {"coalesced": []}),
    check(4, {"calls": [2, 0]})),
  rule("closed-scope-bypasses-dark-work", "closedScopeCallerBypassesLayersAndAdmitsNoJobTest",
    [command("init"), command("policy", 0), command("closeScope", 0), command("beginCall", 0), command("advance", 10)],
    check(3, {"policyCalls": 0, "reads": 0, "shadow": [], "sourceScopes": [false]}),
    check(4, {"calls": [0]}, {"fallbackErrors": []})),
  rule("held-dark-capacity-is-instance-local", "fullInstanceDropsAnotherKeyWhileTheC0ReadIsHeldTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("beginCall", 1), command("beginCall", 4)],
    check(3, {"reads": 1, "shadow": ["dropped"]}),
    check(4, {"reads": 2, "shadow": ["dropped"]})),
  rule("held-dark-dump-error-preserves-source", "dumpFaultEndsTheFillWithoutReplacingTheCallerResultTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1), command("dumpFault", 1), command("releaseDump", 0)],
    check(6, {"calls": [1], "shadow": ["fill_error"], "writes": 0})),
  rule("dark-source-local-publication-stops-job", "localPublicationStopsLaterDarkWorkTest",
    [command("init"), command("policy", 2), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1), command("beginCall", 0)],
    check(4, {"calls": [1], "dumps": 1}),
    check(5, {"calls": [1, 1], "loaders": 1, "reads": 1, "shadow": []})),
  rule("held-dark-c0-age-at-verdict", "retainedC0AgeIsSampledAtTheVerdictTest",
    [command("init"), command("policy", 3), command("seed", 2), command("beginCall", 0), command("releaseRead", 0), command("advance", 1), command("resolveLoader", 2), command("releaseLoad", 0), command("releaseRead", 1)],
    check(6, {"calls": [2], "loads": 1}),
    check(7, {"reads": 2, "shadow": []}),
    check(8, {"shadow": ["mismatch"], "dumps": 0}, {"ages": [60000]})),
  rule("future-dark-c0-reports-offset-and-fills", "rollbackMakesTheSeededFrameFutureAndReportsItsOffsetTest",
    [command("init"), command("policy", 3), command("seed", 0), command("rollbackWall"), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 2), command("releaseDump", 0), command("releaseWrite", 0)],
    check(5, {}, {"futureOffsets": [{"layer": "remote_shadow", "offsetMs": 1000}]}),
    check(8, {"shadow": ["filled"]})),
  rule("transient-request-dark-error-uses-request-layer", "transientRequestOnlySourceFailureIsAttributedToRequestLayerTest",
    [command("init"), command("policy", 1), command("beginCall", 6), command("releaseRead", 0), command("rejectLoader", 0)],
    check(4, { calls: [3], shadow: ["source_error"] }, { fallbackErrors: ["request_local"] })),
  rule("timed-out-dark-read-retains-capacity-until-raw-release", "timedOutDarkReadKeepsCapacityUntilRawReleaseTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("resolveLoader", 1), command("advance", 10), command("beginCall", 1), command("resolveLoader", 3), command("releaseRead", 0), command("beginCall", 1)],
    check(4, {"calls": [1], "shadow": ["timeout"]}),
    check(5, {"calls": [1, 0], "loaders": 2, "reads": 1, "shadow": ["timeout", "dropped"]}),
    check(7, {"reads": 1, "shadow": ["timeout", "dropped"], "dumps": 0, "writes": 0, "loads": 0}),
    check(8, {"calls": [1, 1, 0], "loaders": 3, "reads": 2, "shadow": ["timeout", "dropped"]})),
  rule("timed-out-dark-decode-retains-capacity-until-raw-release", "timedOutDarkDecodeKeepsCapacityUntilRawReleaseTest",
    [command("init"), command("policy", 3), command("seed", 0), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 2), command("advance", 10), command("beginCall", 1), command("resolveLoader", 3), command("releaseLoad", 0), command("beginCall", 1)],
    check(6, {"calls": [2], "shadow": ["timeout"]}),
    check(7, {"calls": [2, 0], "loaders": 2, "reads": 1, "shadow": ["timeout", "dropped"]}),
    check(9, {"reads": 1, "shadow": ["timeout", "dropped"], "dumps": 0, "writes": 0}),
    check(10, {"calls": [2, 1, 0], "loaders": 3, "reads": 2, "shadow": ["timeout", "dropped"]})),
  rule("timed-out-dark-confirmation-retains-capacity-until-raw-release", "timedOutDarkConfirmationKeepsCapacityUntilRawReleaseTest",
    [command("init"), command("policy", 3), command("seed", 0), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 2), command("releaseLoad", 0), command("advance", 10), command("beginCall", 1), command("resolveLoader", 3), command("releaseRead", 1), command("beginCall", 1)],
    check(7, {"calls": [2], "shadow": ["timeout"]}),
    check(8, {"calls": [2, 0], "loaders": 2, "reads": 2, "shadow": ["timeout", "dropped"]}),
    check(10, {"reads": 2, "shadow": ["timeout", "dropped"], "dumps": 0, "writes": 0}),
    check(11, {"calls": [2, 1, 0], "loaders": 3, "reads": 3, "shadow": ["timeout", "dropped"]})),
  rule("timed-out-dark-dump-retains-capacity-until-raw-release", "timedOutDarkDumpKeepsCapacityUntilRawReleaseTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1), command("advance", 10), command("beginCall", 1), command("resolveLoader", 3), command("releaseDump", 0), command("beginCall", 1)],
    check(5, {"calls": [1], "shadow": ["timeout"]}),
    check(6, {"calls": [1, 0], "loaders": 2, "reads": 1, "shadow": ["timeout", "dropped"]}),
    check(8, {"reads": 1, "shadow": ["timeout", "dropped"], "writes": 0}),
    check(9, {"calls": [1, 1, 0], "loaders": 3, "reads": 2, "shadow": ["timeout", "dropped"]})),
  rule("timed-out-dark-write-retains-capacity-until-raw-release", "timedOutDarkWriteKeepsCapacityUntilRawReleaseTest",
    [command("init"), command("policy", 3), command("beginCall", 0), command("releaseRead", 0), command("resolveLoader", 1), command("releaseDump", 0), command("advance", 10), command("beginCall", 1), command("resolveLoader", 3), command("releaseWrite", 0), command("beginCall", 1)],
    check(6, {"calls": [1], "shadow": ["timeout"]}),
    check(7, {"calls": [1, 0], "loaders": 2, "reads": 1, "shadow": ["timeout", "dropped"]}),
    check(9, {"reads": 1, "shadow": ["timeout", "dropped"], "writes": 1}),
    check(10, {"calls": [1, 1, 0], "loaders": 3, "reads": 2, "shadow": ["timeout", "dropped"]})),
];

// The two sampled interactions also use only external commands and the public
// observations. A local insertion is inferred from a successful owned source;
// the expiry probe bypasses request memoization and must start another loader.
export function darkLayersWitnesses(histories, recorder = createWitnessRecorder()) {
  publicPrefixWitnesses(histories, darkLayersWitnessRules, recorder);
  for (const { path, states } of histories) {
    recorder.enter(path);
    let now = 0, policy = 0, previous;
    const closed = new Set(), loaders = new Map(), published = new Map();
    for (const [step, raw] of states.entries()) {
      const input = explicitInput(raw, path), state = decodeIntegers(raw.s, path);
      const observation = state.o, diagnostics = state.d;
      if (input.name === "advance") now += input.choice;
      if (input.name === "policy") policy = input.choice;
      if (input.name === "closeScope") closed.add(input.choice);
      if (previous && input.name === "beginCall") {
        const context = Math.floor(input.choice / 2), key = input.choice % 2;
        const instance = context === 2 || context === 4 ? 1 : 0;
        const identity = `${instance}:${key}`;
        const local = [0, 2, 4, 5, 6, 7].includes(policy) && !closed.has(context);
        if (observation.loaders === previous.o.loaders + 1) {
          loaders.set(previous.o.loaders, { identity, local, call: previous.o.calls.length, step });
          const insertion = published.get(identity);
          if (local && context >= 3 && insertion && now - insertion.time >= 60_000
              && observation.calls.at(-1) === 0) {
            recorder.credit("local-entry-expires-at-its-ttl", insertion.step, step);
          }
        }
        if (observation.calls.length === previous.o.calls.length + 1 && observation.calls.at(-1) === 0
            && observation.loaders === previous.o.loaders
            && diagnostics.coalesced.length === previous.d.coalesced.length + 1
            && diagnostics.coalesced.at(-1) === "request_local") {
          recorder.credit("request-follower-joins-leader", step);
        }
      }
      if (previous && input.name === "resolveLoader") {
        const loader = loaders.get(Math.floor((input.choice - 1) / 2));
        if (loader?.local && previous.o.calls[loader.call] === 0
            && [1, 2].includes(observation.calls[loader.call])) {
          published.set(loader.identity, { time: now, step });
        }
      }
      previous = state;
    }
  }
  return recorder.labels();
}
