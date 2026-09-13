module kernel_types {
  // The first kernel slice owns serving calls, flights and source publication.
  // Absence, source lifetime and logical completion have distinct sum types.
  type Result = Pending | Value(int) | SourceError | Timeout
  type Phase = Reading | Decoding | Loading | Serializing | Writing | Finished
  type RawStatus = Running | Abandoned | Settled
  type Entry = Missing | Present({ value: int, created: int })

  type Config = {
    request: bool,
    local: bool,
    remote: bool,
    tracked: bool,
    capacity: int,
    sourceBudget: int,
    readBudget: int,
    tickMs: int,
    initialWall: int,
    diagnostics: bool,
    maxCalls: int
  }
  type Settlement = { read: bool, load: bool, dump: bool, write: bool }
  type Input = { name: str, choice: int }
  type Call = {
    instance: int,
    key: int,
    context: int,
    slot: int,
    owner: int,
    result: Result
  }
  type Execution = {
    instance: int,
    key: int,
    shared: bool,
    local: bool,
    remote: bool,
    phase: Phase,
    result: Result,
    read: int,
    source: int,
    readStarted: int,
    sourceStarted: int,
    decodeStarted: int,
    deadline: int,
    fence: int,
    refill: bool,
    acquiredValue: int,
    acceptedAt: int,
    acceptedWall: int,
    writeStamp: int
  }
  type RawSource = { owner: int, status: RawStatus }
  type RawRead = { owner: int, status: RawStatus, budget: int }
  type Counts = {
    reads: int,
    loaders: int,
    loads: int,
    dumps: int,
    writes: int,
    invalidations: int,
    policyCalls: int,
    readAborts: int
  }
  type Event = { event: str, location: str, detail: str, amount: int }
  type State = {
    config: Config,
    now: int,
    wall: int,
    policy: int,
    closed: List[bool],
    memo: List[Entry],
    local: List[Entry],
    lru: List[List[int]],
    remote: List[Entry],
    watermarks: List[int],
    calls: List[Call],
    executions: List[Execution],
    sources: List[RawSource],
    reads: List[RawRead],
    counts: Counts,
    events: List[Event],
    lastExecution: int,
    writeTtls: List[int],
    maintenance: List[str]
  }

  pure def resultCode(result: Result): int = match result {
    Pending => 0
    | Value(value) => value
    | SourceError => 3
    | Timeout => 4
  }
  pure def rawCode(status: RawStatus): int = match status {
    Running => 0
    | Abandoned => 1
    | Settled => 2
  }
  pure def phaseCode(phase: Phase): int = match phase {
    Finished => 0
    | Loading => 1
    | Writing => 2
    | Reading => 3
    | Decoding => 4
    | Serializing => 5
  }
  pure def entryValue(entry: Entry): int = match entry {
    Missing => 0
    | Present(frame) => frame.value
  }
  pure def entryStamp(entry: Entry): int = match entry {
    Missing => 0
    | Present(frame) => frame.created
  }
  pure def mapList(values: List[a], transform: (a) => b): List[b] =
    values.foldl(List(), (out, value) => out.append(transform(value)))
  pure val emptyExecution: Execution = {
    instance: 0,
    key: 0,
    shared: false,
    local: false,
    remote: false,
    phase: Finished,
    result: Pending,
    read: 0,
    source: 0,
    readStarted: 0,
    sourceStarted: 0,
    decodeStarted: 0,
    deadline: 0,
    fence: 0,
    refill: false,
    acquiredValue: 0,
    acceptedAt: 0,
    acceptedWall: 0,
    writeStamp: 0
  }
}
