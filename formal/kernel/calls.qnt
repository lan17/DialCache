module calls {
  // What a caller asks for: the instance it runs on, its key (an entity and
  // operation, indexed per instance) and the request context whose scope it
  // memoizes into. The policy gate holds a call with the caller waiting for
  // its reply, so a release never re-supplies it.
  type Call = { instance: int, key: int, context: int }
}
