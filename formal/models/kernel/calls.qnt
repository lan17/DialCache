module calls {
  // What a caller asks for: the instance it runs on, its key and the request context whose scope
  // it memoizes into, with the two flags that make a caller a bypass.
  //
  // Rules
  // - A key is an entity and operation, indexed per instance; the context is the request scope
  //   whose memo row the caller memoizes into.
  // - `enabled` is false for a caller that uses no layer and makes no policy call: a context
  //   created with caching disabled, a key that failed to construct, a call outside every request.
  // - `keyFailed` marks the failed key, the one bypass whose source keeps the configured deadline
  //   (C27); a disabled context and a call outside every request run theirs unbounded (C01).
  // - Decoders set `keyFailed` only for a key that failed inside an enabled, open request, the
  //   order the implementation checks in (enablement first): it implies `enabled: false` today.
  // - `serving::participating` checks `keyFailed` too, so a call carrying both flags still
  //   bypasses caching with its configured source deadline.
  // - The policy gate holds a call with the caller waiting for its reply (`policy_gate::hold`), so
  //   a release never re-supplies it.
  // Shapes
  // - Call: instance, key, context, `enabled` and `keyFailed`; what every admission takes.
  // Consumers: every composed profile; composed through `serving`, `policy_gate`, `flights` and
  //   most other kernel modules.
  type Call = { instance: int, key: int, context: int, enabled: bool, keyFailed: bool }
}
