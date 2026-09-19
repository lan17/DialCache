// The causally-ready-v1 settlement contract, made checkable. A behavior driver
// attaches a receipt to every observation: its controlled monotonic clock, what
// one zero-time verification drain found after the reported snapshot, and the
// external gates it still holds. The ledger below derives what the schedule
// requires from the commands the coordinator issued plus the driver's own public
// counters, so every rule is a driver-integrity check: a library fault that
// starts an extra source moves the counters, the ledger and the driver's clock
// together, passes here, and then fails the observation comparison where the
// mutation lanes credit it. Violations carry no comparison markers. The core
// driver attaches no receipt: its commands are awaited request/response, so
// its ledger holds it to the wall-clock rule alone.
export const receiptDefinition = "settlementReceipt";

// Every controlled driver starts its wall clock at 2026-09-08T12:00:00.000Z.
export const wallEpochMs = 1788868800000;

// Held effects by kind: the counter the driver increments before parking on the
// gate, the fault flag that parks it, and the receipt member that reports it.
const kinds = {
  read: { counter: "reads", hold: "holdReads", held: "reads" },
  write: { counter: "writes", hold: "holdWrites", held: "writes" },
  dump: { counter: "dumps", hold: "holdDumps", held: "dumps" },
  load: { counter: "loads", hold: "holdLoads", held: "loads" },
  policy: { counter: "policyCalls", hold: "holdPolicies", held: "policies" },
};

// Receipt member to the gate kind named in an R5 violation, in report order.
const gateNames = { loaders: "loader", reads: "read", writes: "write", dumps: "dump", loads: "load", policies: "policy", scopes: "scope" };

function violation(message) {
  return new Error(`Settlement violation: ${message}`);
}

// The four rule texts assert() produces, for the mutation runners: a failure
// that matches is the driver failing its own contract and is recorded against
// the mutant, never read as a detection. A test that quotes the phrase in an
// expectation prints it into its failure message; matching the rule texts,
// not the phrase, keeps such a failure a detection. Kept beside the texts so
// a new or reworded rule changes both together.
export const settlementViolationPattern = /Settlement violation: (?:\d+ runnable task\(s\) at observation|monotonic clock at|wall clock at|\w+ gates held)/;

export class SettlementLedger {
  #fixture;
  #hold = { read: false, write: false, dump: false, load: false, policy: false };
  #heldStarted = { read: 0, write: 0, dump: 0, load: 0, policy: 0 };
  #released = { read: 0, write: 0, dump: 0, load: 0, policy: 0 };
  #previous = { reads: 0, writes: 0, dumps: 0, loads: 0, policyCalls: 0 };
  #settled = 0;
  #advanceMs = 0;
  #shiftWallMs = 0;
  #openScopes = 0;
  // Commands issued since the previous observation that can start an effect.
  #effectsSinceObservation = 0;

  constructor(fixture, setup = []) {
    this.#fixture = fixture;
    this.issue(setup);
  }

  // Record the commands issued since the previous observation.
  issue(commands) {
    for (const command of commands) {
      if (command.op === "faults") {
        for (const [kind, { hold }] of Object.entries(kinds)) {
          if (!Object.hasOwn(command.value, hold) || command.value[hold] === this.#hold[kind]) continue;
          // R5 attributes every effect started since the previous observation
          // by the hold flags in force at that observation, while both drivers
          // decide holding when the effect starts. The two agree only while a
          // hold change precedes every effect-starting command of its interval,
          // so any other schedule is refused as the ledger's own limit, not as
          // a violation by the driver.
          if (this.#effectsSinceObservation > 0) {
            throw new Error(`Settlement ledger cannot attribute held gates: ${hold} changes after an effect-starting command in one observation interval`);
          }
          this.#hold[kind] = command.value[hold];
        }
        continue;
      }
      // Seeding the remote and opening a scope start no gated effect.
      if (command.op !== "seed" && command.op !== "openScope") this.#effectsSinceObservation++;
      switch (command.op) {
        case "release": this.#released[command.effect]++; break;
        case "resolve": case "reject": this.#settled++; break;
        case "advance": this.#advanceMs += command.ms; break;
        // Core's advanceWall moves only the wall clock: that driver has no
        // controlled monotonic clock to report.
        case "shiftWall": case "advanceWall": this.#shiftWallMs += command.ms; break;
        case "openScope": this.#openScopes++; break;
        case "closeScope": this.#openScopes--; break;
        default: break;
      }
    }
  }

  // The receipt the schedule requires for an observation. Effects started since
  // the previous observation are held when their kind's hold flag is on; the
  // driver's counters are the only observation fields read. Calling this twice
  // for the same observation is harmless: the second call sees no new starts.
  expected(observed) {
    const held = { loaders: observed.loaders - this.#settled, scopes: this.#openScopes };
    for (const [kind, { counter, held: member }] of Object.entries(kinds)) {
      const started = observed[counter] - this.#previous[counter];
      if (this.#hold[kind]) this.#heldStarted[kind] += started;
      this.#previous[counter] = observed[counter];
      held[member] = this.#heldStarted[kind] - this.#released[kind];
    }
    this.#effectsSinceObservation = 0;
    return { elapsedMs: this.#advanceMs + this.#workMs(observed), runnable: 0, held };
  }

  // The wall clock the schedule requires: the epoch plus every advance and
  // wall shift, plus the fixture work the driver consumes inside callbacks.
  wallMs(observed) {
    return wallEpochMs + this.#advanceMs + this.#shiftWallMs + this.#workMs(observed);
  }

  // Check a driver's receipt and reported wall clock against the schedule, in
  // the order R2 (quiescence), R3 (monotonic clock), R4 (wall clock), R5 (held
  // gates). Reported values enter the message only as the numbers compared.
  assert(receipt, observed, environment) {
    const required = this.expected(observed);
    if (receipt.runnable !== 0) throw violation(`${receipt.runnable} runnable task(s) at observation`);
    if (receipt.elapsedMs !== required.elapsedMs) {
      throw violation(`monotonic clock at ${receipt.elapsedMs} ms, schedule requires ${required.elapsedMs} ms`);
    }
    this.assertWallClock(observed, environment);
    for (const [member, gate] of Object.entries(gateNames)) {
      if (receipt.held[member] !== required.held[member]) {
        throw violation(`${gate} gates held ${receipt.held[member]}, schedule requires ${required.held[member]}`);
      }
    }
  }

  // R4 alone, for a session that carries no receipt but controls its wall
  // clock (core).
  assertWallClock(observed, environment) {
    const wallMs = this.wallMs(observed);
    if (environment.wallMs !== wallMs) throw violation(`wall clock at ${environment.wallMs} ms, schedule requires ${wallMs} ms`);
  }

  // Elapsed time the two fixture sentinels consume inside callbacks. Only a
  // fixture that names a sentinel reads the matching observation counter, so
  // the core fixture `{}` requires no work of a core observation.
  #workMs(observed) {
    let ms = 0;
    if (this.#fixture.sourceWorkMs) ms += observed.loaders * this.#fixture.sourceWorkMs;
    if (this.#fixture.comparisonMs) ms += observed.comparisons * this.#fixture.comparisonMs;
    return ms;
  }
}
