import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Quint's deterministic test export omits MBT metadata. These models record
// their external inputs explicitly. Normalize that declaration into the same
// portable envelope as sampled histories; never reconstruct inputs from state
// differences, expected observations, or implementation results.
export function normalizeReplayInputs(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace) || !Array.isArray(trace.states) || trace.states.length < 2) throw new Error('Replay requires initialization and a transition');
  for (const [index, state] of trace.states.entries()) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`Invalid replay state at step ${index}`);
    const input = state.input;
    if (!input || Object.keys(input).sort().join() !== 'choice,name' ||
        typeof input.name !== 'string' || !/^[A-Za-z_]\w*$/.test(input.name) ||
        (index === 0 ? input.name !== 'init' : input.name === 'init')) throw new Error(`Invalid explicit input at step ${index}`);
    const encoded = input.choice;
    if (!encoded || Object.keys(encoded).join() !== '#bigint' || typeof encoded['#bigint'] !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(encoded['#bigint'])) throw new Error(`Invalid explicit choice at step ${index}`);
    const choice = Number(encoded['#bigint']);
    if (!Number.isSafeInteger(choice) || choice < -1) throw new Error(`Unsafe explicit choice at step ${index}`);
    state['mbt::actionTaken'] = input.name;
    state['mbt::nondetPicks'] = { choice: choice === -1
      ? { tag: 'None', value: { '#tup': [] } }
      : { tag: 'Some', value: encoded } };
  }
  trace.vars = [...new Set([...(trace.vars ?? []), 'mbt::actionTaken', 'mbt::nondetPicks'])];
  return trace;
}

// Normalize every ITF history a directory holds, in place, as the generation
// lane and the differential both do before a corpus is read or fingerprinted;
// returns how many histories were rewritten.
export function normalizeTraceFiles(directory) {
  let normalized = 0;
  for (const name of readdirSync(directory).filter(name => name.endsWith('.itf.json'))) {
    const path = resolve(directory, name);
    writeFileSync(path, JSON.stringify(normalizeReplayInputs(JSON.parse(readFileSync(path, 'utf8')))) + '\n');
    normalized++;
  }
  return normalized;
}
