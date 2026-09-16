module calls {
  // What a caller asks for: the instance it runs on, its key (an entity and
  // operation, indexed per instance) and the request context whose scope it
  // memoizes into; `enabled` is false for a caller that uses no layer and makes
  // no policy call (a context created with caching disabled, a key that failed
  // to construct, a call outside every request), and `keyFailed` marks the
  // second of these: the one bypass whose source keeps the configured deadline
  // (C27), where a disabled context and a call outside every request run
  // theirs unbounded (C01). The policy gate holds a call with the caller
  // waiting for its reply, so a release never re-supplies it.
  type Call = { instance: int, key: int, context: int, enabled: bool, keyFailed: bool }
}
