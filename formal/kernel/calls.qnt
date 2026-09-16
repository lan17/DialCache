module calls {
  // What a caller asks for: the instance it runs on, its key (an entity and
  // operation, indexed per instance) and the request context whose scope it
  // memoizes into; `enabled` is false for a caller outside every request or in
  // a context created with caching disabled, which uses no layer and makes no
  // policy call (C01). The policy gate holds a call with the caller waiting
  // for its reply, so a release never re-supplies it.
  type Call = { instance: int, key: int, context: int, enabled: bool }
}
