const range = length => Array.from({ length }, (_, index) => index);
const useCase = "DarkLayers";
function policy(choice) {
  const changed = choice === 7 || choice === 8;
  return {
    requestLocal: [0, 1, 4, 6, 7].includes(choice), coalesce: ![4, 5].includes(choice),
    ttlSec: { local: 60, remote: changed ? 120 : 60 },
    staleOnErrorMaxAgeSec: changed ? 180 : 120,
    ramp: { local: [0, 2, 4, 5, 6, 7].includes(choice) ? 100 : 0, remote: 0 },
    shadow: { ramp: choice === 6 ? 0 : 100 },
  };
}
function seed(choice, _observed, environment) {
  const kind = choice % 6;
  const base = { op: "seed", key: String(Math.floor(choice / 6)), useCase,
    ageMs: kind === 2 ? 59_999 : kind === 3 ? 60_000 : 0, ttlMs: 180_000 };
  if (kind === 4) return { ...base, payloadHex: "016e6f742061207a737464206672616d65" };
  if (kind === 5) {
    const frame = Buffer.alloc(11);
    frame[0] = 1; frame.writeBigUInt64BE(BigInt(environment.wallMs), 1); frame[9] = 255; frame[10] = 49;
    return { ...base, frameHex: frame.toString("hex") };
  }
  return { ...base, value: kind === 1 ? 2 : 1 };
}
const release = effect => ({ choices: range(24), input: index => ({ op: "release", effect, index }) });
const fault = field => ({ choices: [0, 1], input: choice => ({ op: "faults", value: { [field]: choice === 1 } }) });

// The held dark path composes source deadlines, scopes, local storage and
// tracked invalidation. Every timestamp and effect id is an external input.
export const darkLayersProfile = {
  explicitInputs: true, diagnosticAge: "shadowAge", diagnosticUseCase: useCase,
  diagnosticConfigErrors: true, diagnosticFutureOffsets: true, diagnosticInspections: true,
  fixture: { policy: policy(0), tracked: true, fallbackTimeoutMs: 10, readTimeoutMs: 30_000_000,
    shadowMaxInFlight: 1, recovery: "allow", probeSourceScope: true,
    observe: ["shadowAge", "futureOffset", "coalesced", "error", "coalescingState"] },
  setup: range(3).map(scope => ({ op: "openScope", id: String(scope), instance: scope === 2 ? "1" : "0" }))
    .concat([{ op: "faults", value: { holdReads: true, holdLoads: true, holdDumps: true, holdWrites: true } }]),
  actions: {
    beginCall: { choices: range(10), input: choice => {
      const context = Math.floor(choice / 2);
      return { op: "begin", key: String(choice % 2), useCase,
        ...(context < 3 ? { scope: String(context) } : { instance: context === 4 ? "1" : "0" }) };
    } },
    resolveLoader: { choices: range(24).map(index => index + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
    rejectLoader: { choices: range(12), input: loader => ({ op: "reject", loader }) },
    releaseRead: release("read"), releaseLoad: release("load"), releaseDump: release("dump"), releaseWrite: release("write"),
    advance: { choices: [1, 10, 60_000], input: ms => ({ op: "advance", ms }) },
    policy: { choices: range(9), input: choice => ({ op: "policy", value: policy(choice) }) },
    seed: { choices: range(12), input: seed },
    invalidate: { choices: range(4), input: choice => ({ op: "invalidate", key: String(Math.floor(choice / 2)), futureBufferMs: (choice % 2) * 20 }) },
    closeScope: { choices: range(3), input: choice => ({ op: "closeScope", id: String(choice) }) },
    inspect: { choices: [0, 1], input: instance => ({ op: "inspectCoalescing", instance: String(instance) }) },
    rollbackWall: { input: () => ({ op: "shiftWall", ms: -1000 }) },
    readFault: fault("read"), loadFault: fault("load"), dumpFault: fault("dump"), writeFault: fault("write"),
  },
};
