import { AssertionError } from "node:assert";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { profileActions, bindTrace } from "./bindings.mjs";
import { parseJSON, replayLines } from "./validation.mjs";
import { assertSchema, schemaViolation } from "./schema.mjs";
import { SettlementLedger, receiptDefinition } from "./settlement.mjs";
import { diffPaths, isObservationComparison } from "./divergence.mjs";

export const protocolVersion = 1;
export const settlement = "causally-ready-v1";

// The coordinator retains predictions. Its wire replies contain only fixtures,
// external commands, and assertion acknowledgements; drivers never see them.
export class ReplayCoordinator {
  #sessions = new Map();
  #nextSession = 0;
  #lastRequest = 0;
  #record;
  #onRecord;
  #recordings = new Map();

  constructor({ record = false, onRecord } = {}) {
    this.#record = record;
    this.#onRecord = onRecord;
  }

  // Recordings are deliberately outside the protocol. Existing drivers keep
  // exact response shapes and never receive expectations or comparison paths.
  recording(session) {
    const value = this.#sessions.get(session)?.recording ?? this.#recordings.get(session);
    return value === undefined ? undefined : structuredClone(value);
  }

  #finish(sessionId, completed, error) {
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (session?.recording === undefined) return;
    const record = { ...session.recording, completed, ...(error === undefined ? {} : { error }) };
    this.#recordings.set(sessionId, record);
    this.#onRecord?.(structuredClone(record));
  }

  // In-process drivers can name an application failure before discarding the
  // session. JSONL drivers' discard retains the step; their test log carries
  // the native failure. Neither is a completed comparison history.
  abort(session, error) {
    if (!this.#sessions.has(session)) return;
    const current = this.#sessions.get(session);
    this.#finish(session, false, `${current.trace.path} step ${current.index} action ${current.trace.steps[current.index].action}: ${error instanceof Error ? error.message : String(error)}`);
  }

  dispatch(request) {
    assertSchema(request, "request");
    if (request.id <= this.#lastRequest) throw new Error("Duplicate or out-of-order replay request");
    this.#lastRequest = request.id;
    const result = this.#dispatch(request);
    assertSchema({ version: protocolVersion, id: request.id, ok: true, result }, "response");
    // Direct callers have the same isolation as callers using JSONL: a driver
    // cannot mutate the shared fixture or registry through a returned reference.
    return structuredClone(result);
  }

  #dispatch(request) {
    if (request.op === "profiles") return { settlement, profiles: profileActions() };
    if (request.op === "prepare") {
      const raw = Object.hasOwn(request, "raw") ? request.raw : readFileSync(request.path, "utf8");
      const binding = bindTrace(request.profile, parseJSON(raw), request.path);
      const { trace } = binding;
      const session = String(++this.#nextSession);
      // A checked session keeps a settlement ledger of the commands it issued:
      // a behavior session's receipts are checked against the schedule the
      // driver actually ran, the core session's wall clock alone. The
      // local-clock driver reports the real process clock, which no rule reads.
      const ledger = binding.settlement === "none" ? undefined : new SettlementLedger(binding.fixture, binding.setup);
      this.#sessions.set(session, { binding, trace, index: 0, ledger,
        ...(this.#record ? { recording: { path: trace.path, divergences: [], completed: false, lastStep: -1 } } : {}) });
      // `observation` and `receipt` name the $defs definitions the driver's
      // records must satisfy, so a port can validate them locally before each
      // round trip; a null receipt means the session carries none.
      return {
        session, settlement, observation: binding.observation, receipt: binding.settlement === "receipt" ? receiptDefinition : null,
        fixture: binding.fixture, setup: binding.setup,
        actions: trace.steps.map(step => step.action), steps: trace.steps.length,
      };
    }
    if (request.op === "discard") {
      if (!this.#sessions.has(request.session)) throw new Error("Unknown replay session");
      this.abort(request.session, "Replay discarded before observation");
      return { discarded: true };
    }

    const session = this.#sessions.get(request.session);
    if (!session) throw new Error("Unknown replay session");
    const { binding, trace, index, ledger } = session;
    try {
      if (request.index !== index) throw new Error("Duplicate or skipped replay observation");
      // A malformed observation is a driver or transport defect, never
      // comparison evidence: report it as a plain infrastructure error.
      const malformed = schemaViolation(request.observed, binding.observation, "observed");
      if (malformed !== undefined) throw new Error(`Malformed replay observation: ${binding.observation} at ${malformed}`);
      // The settlement receipt is checked before the observation is compared,
      // so an unsettled driver fails by name and never earns comparison credit.
      // The binding alone decides whether an observe must carry one; its shape
      // is validated separately from the request so the path names the receipt
      // member. A core session carries none and is held to the wall-clock rule
      // alone; a local-clock session is not checked.
      if (Object.hasOwn(request, "receipt")) {
        if (binding.settlement !== "receipt") throw new Error("Unexpected settlement receipt");
        const shape = schemaViolation(request.receipt, receiptDefinition, "receipt");
        if (shape !== undefined) throw new Error(`Malformed settlement receipt at ${shape}`);
        ledger.assert(request.receipt, request.observed, request.environment);
      } else if (binding.settlement === "receipt") {
        throw new Error("Missing settlement receipt");
      } else {
        ledger?.assertWallClock(request.observed, request.environment);
      }
      try {
        binding.assert(index, request.observed);
      } catch (cause) {
        // Mutation attribution requires actual comparison evidence. Format only
        // an assertion raised while comparing observations; parsing, transport,
        // mapping and lifecycle errors retain their infrastructure diagnostics.
        if (!(cause instanceof AssertionError)) throw cause;
        if (session.recording !== undefined) {
          if (!isObservationComparison(cause)) throw new Error(`Observation projection assertion did not compare a complete record: ${cause.message}`, { cause });
          session.recording.divergences.push({ step: index, action: trace.steps[index].action, paths: diffPaths(cause.expected, cause.actual) });
        } else {
          const expected = JSON.stringify(cause.expected) ?? '{"absent":true}';
          const actual = JSON.stringify(cause.actual) ?? '{"absent":true}';
          throw new Error(`Observation mismatch\nexpected: ${expected}\nactual: ${actual}`, { cause });
        }
      }
      if (session.recording !== undefined) session.recording.lastStep = index;
      const nextIndex = index + 1;
      if (nextIndex === trace.steps.length) {
        this.#finish(request.session, true);
        return { complete: true, steps: trace.steps.length };
      }
      // Only the explicit action descriptor, actual observations, and actual
      // environment reach the mapping. Predictions never choose commands.
      session.index = nextIndex;
      const inputs = binding.commands(nextIndex, request.observed, request.environment);
      for (const input of inputs) assertSchema(input, "command");
      if (inputs.length === 0) throw new Error("Replay action produced no command");
      ledger?.issue(inputs);
      return { complete: false, index: nextIndex, inputs };
    } catch (cause) {
      const error = new Error(`${trace.path} step ${session.index} action ${trace.steps[session.index].action}: ${cause.message}`);
      this.#finish(request.session, false, error.message);
      throw error;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const recordingPath = process.env.DIALCACHE_REPLAY_DIVERGENCES;
  const coordinator = new ReplayCoordinator(recordingPath === undefined ? {} : {
    record: true, onRecord: record => appendFileSync(recordingPath, `${JSON.stringify(record)}\n`),
  });
  const lines = replayLines(process.stdin);
  for await (const line of lines) {
    let request;
    try {
      request = parseJSON(line);
      const result = coordinator.dispatch(request);
      process.stdout.write(`${JSON.stringify({ version: protocolVersion, id: request.id, ok: true, result })}\n`);
    } catch (error) {
      const id = Number.isSafeInteger(request?.id) && request.id > 0 ? request.id : null;
      process.stdout.write(`${JSON.stringify({ version: protocolVersion, id, ok: false, error: error.message })}\n`);
    }
  }
}
