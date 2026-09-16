module calls {
  // What a caller asks for: the instance it runs on, its key (an entity and
  // operation, indexed per instance) and the request context whose scope it
  // memoizes into; `enabled` is false for a caller that uses no layer and makes
  // no policy call (a context created with caching disabled, a key that failed
  // to construct, a call outside every request), and `outside` for the last of
  // these, whose source also has no deadline (C01, C27). The policy gate holds
  // a call with the caller waiting for its reply, so a release never
  // re-supplies it.
  type Call = { instance: int, key: int, context: int, enabled: bool, outside: bool }
}
