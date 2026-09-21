const range = length => Array.from({ length }, (_, index) => index);
const release = effect => ({ choices: range(16), input: index => ({ op: "release", effect, index }) });

// Dark source/job and read budgets are separate external inputs. Actual read
// ordinals bind raw releases, cancellation signals and captured contexts.
export const shadowReadDeadlinesProfile = {
  explicitInputs: true, readIO: true, diagnosticAge: "shadowAge",
  diagnosticConfigErrors: true, diagnosticFutureOffsets: true,
  fixture: { policy: { requestLocal: false, ttlSec: { local: 60, remote: 60 },
      ramp: { local: 0, remote: 0 }, shadow: { ramp: 100 } },
    tracked: true, fallbackTimeoutMs: 10, readTimeoutMs: 5,
    shadowMaxInFlight: 1, probeSourceScope: true,
    observe: ["shadowAge", "futureOffset", "coalesced", "error", "readContext", "readAbort"] },
  setup: [{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }],
  actions: {
    beginCall: { choices: [0, 1], input: choice => ({ op: "begin", key: String(choice) }) },
    resolveLoader: { choices: range(16).map(index => index + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
    rejectLoader: { choices: range(8), input: loader => ({ op: "reject", loader }) },
    releaseRead: release("read"), releaseLoad: release("load"), releaseDump: release("dump"), releaseWrite: release("write"),
    advance: { choices: [1, 4, 5, 10, 20], input: ms => ({ op: "advance", ms }) },
    policy: { choices: [5, 20], input: choice => ({ op: "policy", value: { remoteReadTimeoutMs: choice } }) },
    seed: { choices: range(4), input: choice => ({ op: "seed", key: String(Math.floor(choice / 2)), value: choice % 2 + 1, ttlMs: 60000 }) },
  },
};
