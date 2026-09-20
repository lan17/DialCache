module remote_writes {
  // The atomic remote lifecycle with held writes: a flight whose read was
  // atomic (`serving::release`) and whose refill the drivers hold and release
  // by effect index, the serialization (`dump`) first, then the write. A
  // refill serializes when its source settles accepted (the dump counted
  // then; `serving::refills` judged then with the retention the source
  // captured and the fence its read observed, C18/C58), dispatches its write
  // when the dump is released (`serving::dispatchWrite`; the frame is stamped
  // with the wall clock of that release, after serialization, C33; a fence the
  // wall no longer clears stops the write and the flight completes without
  // one) and stores the frame when the write is released
  // (`remote_frames::storeFrame` with the captured stamp, retained from the
  // release). The callers the flight owns complete when its write is released
  // or fenced, with the value the source recorded, and local storage is warmed
  // then for the source's local TTL: publication completes with the write.
  // A dump abandoned before its release (a shadow job whose budget expired,
  // `shadow`) dispatches no write. Held dumps and writes are pending-only
  // records keyed by the drivers' effect ordinal (`o.dumps`, `o.writes` at
  // dispatch), like `remote_io`'s held reads. The adapter's dump and write
  // faults are the `failed` argument of the two releases, as `remote_io`
  // takes its read and decode faults (a profile passes its fault switch, or
  // names the fault per effect as effects' `failDump` and `failWrite` do): a
  // failed dump dispatches no write and a failed write stores nothing, and
  // the flight completes either way, as `serving::publish` has it on the
  // atomic path.
  //
  // Stale-on-error on the atomic path (C40 to C46, as `recovery` states them
  // and `remote_io` composes them on the held path): a flight that read the
  // remote layer without serving retains its snapshot at release under the
  // classifier in force (`recovery::retain`, as the held read settlement
  // does); a failed source consults it once (`recovery::failure`, the
  // judgment the held path applies too) and, acquisition and decoding being
  // atomic here, decodes the candidate at once (the decode counted) and completes
  // with the value it decodes to, or with its error, reporting the label the
  // recheck gives (`recovery::recovered`) or a miss when it recovers without a
  // candidate. A profile without stale-on-error passes `Recovery::NONE`.
  import conformance_observations.* from "../conformance-observations"
  import encodings.* from "./encodings"
  import calls.* from "./calls"
  import layer_policy.* from "./layer-policy"
  import serving as Serving from "./serving"
  import remote_frames as Remote from "./remote-frames"
  import flights as Flights from "./flights"
  import recovery as Recovery from "./recovery"
  import payloads as Payloads from "./payloads"
  import clock as Clock from "./clock"

  // A held dump: the drivers' effect ordinal, the flight it serializes for and
  // the write authority it was held with, the retention its write is
  // dispatched with and the fence the write must clear (a caller's refill
  // carries its source's, a job's fill the one its own C0 read observed,
  // `shadow`). A held write keeps the retention and adds the stamp captured
  // when its dump was released.
  type HeldDump = { dump: int, source: int, retentionMs: int, fence: int }
  type HeldWrite = { write: int, source: int, retentionMs: int, stamp: int }
  type Writing[r] = Serving::Served[{ dumps: List[HeldDump], writes: List[HeldWrite], retained: List[Recovery::Snapshot] | r }]

  pure def holdsDump(state: Writing[r], dump: int): bool = state.dumps.select(held => held.dump == dump).length() > 0
  pure def heldDump(state: Writing[r], dump: int): HeldDump = state.dumps.select(held => held.dump == dump).nth(0)
  pure def holdsWrite(state: Writing[r], write: int): bool = state.writes.select(held => held.write == write).length() > 0
  pure def heldWrite(state: Writing[r], write: int): HeldWrite = state.writes.select(held => held.write == write).nth(0)
  // The most recently held dump and write (the held lists are in dispatch
  // order), for a profile whose drivers release the latest effect.
  pure def latestDump(state: Writing[r]): HeldDump = state.dumps.nth(state.dumps.length() - 1)
  pure def latestWrite(state: Writing[r]): HeldWrite = state.writes.nth(state.writes.length() - 1)

  // -- Release ---------------------------------------------------------------------

  // The layered release applied from its judgment, retaining the snapshot of
  // a source it starts after a completed remote read that served nothing (the
  // candidate, if any, is the visible frame the traversal declined). The
  // failure of such a source is judged once in `recovery::failure`, as the
  // held path's is. The module's one release seam: `shadow` judges the
  // release and applies it here, then admits its jobs beside it.
  pure def releaseJudged(state: Writing[r], layout: Serving::Layout, judged: Serving::LayeredRelease, policyCall: int, ttls: Ttls, classifier: int): Writing[r] = {
    val released = Serving::releaseJudged(state, layout, judged, policyCall, ttls)
    match judged.decision.outcome {
      | Starts => if (judged.effective.layers.remote and not(judged.remote.failed))
          Recovery::retain(released, released.sources.length() - 1, judged.call.key, judged.remote.visible, effectiveTtls(judged.effective, ttls), classifier)
        else released
      | _ => released
    }
  }

  // -- Completion --------------------------------------------------------------------

  // Every owner completes with the value; the flight's snapshot, if any, is dropped.
  pure def complete(state: Writing[r], layout: Serving::Layout, flight: int, value: int): Writing[r] =
    Recovery::drop(Serving::complete(state, layout, flight, value), flight)
  pure def finish(state: Writing[r], layout: Serving::Layout, flight: int, value: int): Writing[r] =
    complete(Flights::recordResult(state, flight, value), layout, flight, value)
  // A failed source: without a snapshot it completes with its error,
  // unclassified; with one it is classified once and, when recovery is
  // allowed and the candidate's age still allows it, decodes the candidate at
  // once and completes with what it decodes to (or its error after a failed
  // decode, `recovery::recovered`), else completes with its error, a miss
  // reported when recovery was allowed. A deadline error is a timeout for the
  // recovery rules, as is a propagated timeout the profile names.
  pure def failed(state: Writing[r], layout: Serving::Layout, flight: int, error: int, timeout: bool): Writing[r] = {
    val recorded = Flights::recordResult(state, flight, error)
    val snapshot = Recovery::retainedFor(recorded, flight)
    if (snapshot.flight == NO_OWNER) complete(recorded, layout, flight, error)
    else {
      val judged = Recovery::failure(recorded, snapshot, error, timeout)
      if (judged.serves) {
        val decoded = { o: { loads: judged.state.o.loads + 1, ...judged.state.o }, ...judged.state }
        val outcome = Recovery::recovered(decoded, snapshot, Payloads::decodeFails(snapshot.candidate))
        complete(Recovery::recordOutcome(decoded, outcome.label), layout, flight,
          if (outcome.served) Payloads::valueOf(snapshot.candidate) else error)
      }
      else complete(judged.state, layout, flight, error)
    }
  }

  // -- Settlement and the held refill ------------------------------------------------

  // A refill starts with its serialization: the dump is counted and held with
  // the retention the source captured; the flight stays pending.
  pure def holdDump(state: Writing[r], source: int, retentionMs: int, fence: int): Writing[r] = {
    dumps: state.dumps.append({ dump: state.o.dumps, source: source, retentionMs: retentionMs, fence: fence }),
    o: { dumps: state.o.dumps + 1, ...state.o },
    ...state
  }
  // A source settles: an accepted value that refills the remote layer records
  // its outcome, drops its snapshot (an accepted settlement never consults
  // it) and holds its dump (publication completes with the write); an
  // accepted value that does not refill publishes and completes at once
  // (`serving::publish`: a warm for the source's local TTL); an error is
  // classified against the flight's snapshot.
  pure def settle(state: Writing[r], layout: Serving::Layout, index: int, value: int, timeout: bool): Writing[r] = {
    val source = state.sources.nth(index)
    if (not(accepted(value))) failed(state, layout, index, value, timeout)
    else if (Serving::refills(state, source, value)) holdDump(Recovery::drop(Flights::recordResult(state, index, value), index), index, source.retentionMs, source.fence)
    else finish(Serving::publish(state, layout, index, value), layout, index, value)
  }
  // The dump released: when the wall clock still clears the fence the dump
  // was held with, the write is dispatched with the dump's retention and
  // stamped now (the stamp after serialization, C33); a fence it does not
  // clear stops the write. Whether a write was dispatched is read from the count.
  pure def dispatch(state: Writing[r], dump: int): Writing[r] = {
    val held = heldDump(state, dump)
    val dropped = { dumps: state.dumps.select(other => other.dump != dump), ...state }
    if (not(Remote::writeAllowed(state, held.fence))) dropped
    else {
      writes: dropped.writes.append({ write: state.o.writes, source: held.source, retentionMs: held.retentionMs, stamp: Clock::wallOf(state) }),
      ...Serving::dispatchWrite(dropped, held.retentionMs)
    }
  }
  // A dump whose work was abandoned before its release: released, no write.
  pure def abandonDump(state: Writing[r], dump: int): Writing[r] =
    { dumps: state.dumps.select(other => other.dump != dump), ...state }
  // A held write dropped without storing: its write failed.
  pure def abandonWrite(state: Writing[r], write: int): Writing[r] =
    { writes: state.writes.select(other => other.write != write), ...state }
  // A caller's dump released: its write dispatched, or the flight completed
  // without one when the dump failed or the fence stopped it.
  pure def releaseDump(state: Writing[r], layout: Serving::Layout, dump: int, failed: bool): Writing[r] = {
    val held = heldDump(state, dump)
    val dispatched = if (failed) abandonDump(state, dump) else dispatch(state, dump)
    if (dispatched.o.writes > state.o.writes) dispatched
    else complete(Serving::warm(dispatched, layout, state.sources.nth(held.source), state.sources.nth(held.source).result, state.sources.nth(held.source).localMs), layout, held.source, state.sources.nth(held.source).result)
  }
  // The write released: the frame stored with the value the source recorded,
  // the captured stamp and the dump's retention.
  pure def store(state: Writing[r], write: int): Writing[r] = {
    val held = heldWrite(state, write)
    val source = state.sources.nth(held.source)
    Remote::storeFrame({ writes: state.writes.select(other => other.write != write), ...state }, source.key, source.result, held.stamp, held.retentionMs)
  }
  // A caller's write released: the frame stored (nothing under a write
  // fault), local storage warmed for the source's local TTL, every owner
  // completed with the recorded value.
  pure def releaseWrite(state: Writing[r], layout: Serving::Layout, write: int, failed: bool): Writing[r] = {
    val source = state.sources.nth(heldWrite(state, write).source)
    complete(Serving::warm(if (failed) abandonWrite(state, write) else store(state, write), layout, source, source.result, source.localMs),
      layout, heldWrite(state, write).source, source.result)
  }
}
