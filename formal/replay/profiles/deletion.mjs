const range = length => Array.from({ length }, (_, i) => i);
const policies = [{}, { requestLocal: false }, { ramp: { local: 0 } },
  { ramp: { remote: 0 } }, { ramp: { local: 0, remote: 0 } }, { requestLocal: false, ramp: { local: 0, remote: 0 } }];
function identity(choice) {
  const key = choice % 4;
  return { key: String(Math.floor(key / 2)), useCase: `Layers${key % 2}` };
}
function context(choice, deletion) {
  const scope = Math.floor(choice / 4);
  if (scope < 3 || scope === 5) return { [deletion ? "id" : "scope"]: String(scope) };
  return { instance: scope === 4 ? "1" : "0", ...(!deletion && scope === 6 ? { outside: true } : {}) };
}
export const deletionProfile = {
  explicitInputs: true,
  initChoices: range(7),
  fixture: choice => ({ policy: { requestLocal: true, ttlSec: { local: 60, remote: 60 } },
    tracked: choice % 2 === 1, remote: choice < 4 || choice === 6, remoteDeletes: choice !== 6,
    localMaxSize: choice === 2 || choice === 3 ? 0 : 2, fallbackTimeoutMs: null, readTimeoutMs: 30_000_000 }),
  setup: [0, 1, 2].map(scope => ({ op: "openScope", id: String(scope), instance: scope === 2 ? "1" : "0" }))
    .concat([{ op: "openScope", id: "5", parent: "0", disabled: true }]),
  actions: {
    holdDecoding: { input: () => ({ op: "faults", value: { holdLoads: true } }) },
    releaseLoad: { choices: range(20), input: index => ({ op: "release", effect: "load", index }) },
    beginCall: { choices: range(28), input: choice => ({ op: "begin", ...identity(choice), ...context(choice, false) }) },
    deleteEntry: { choices: range(28), input: choice => ({ op: "delete", ...identity(choice), ...context(choice, true) }) },
    resolveLoader: { choices: range(40).map(i => i + 1), input: choice => ({ op: "resolve", loader: Math.floor((choice - 1) / 2), value: (choice - 1) % 2 + 1 }) },
    rejectLoader: { choices: range(20), input: loader => ({ op: "reject", loader }) },
    closeScope: { choices: [0, 1, 2], input: id => ({ op: "closeScope", id: String(id) }) },
    policy: { choices: range(6), input: choice => ({ op: "policy", value: policies[choice] }) },
    seed: { choices: range(8), input: choice => ({ op: "seed", ...identity(Math.floor(choice / 2)), value: choice % 2 + 1 }) },
    invalidate: { choices: [0, 1], input: key => ({ op: "invalidate", key: String(key) }) },
    tick: { input: () => ({ op: "advance", ms: 1 }) },
    remoteFault: { choices: [0, 1], input: choice => ({ op: "faults", value: { write: choice === 1 } }) },
  },
};
