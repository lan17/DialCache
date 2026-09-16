module layer_policy {
  // Which serving layers a call may use, from the policy code the conformance
  // drivers share (formal/replay/features.mjs layerPolicies) and the presence
  // of remote storage. Codes are part of the driver contract; do not renumber.
  pure val ALL_LAYERS = 0
  pure val NO_REQUEST_LAYER = 1
  pure val NO_LOCAL_LAYER = 2
  pure val NO_REMOTE_LAYER = 3
  pure val REQUEST_LAYER_ONLY = 4
  pure val NO_LAYERS = 5

  type Layers = { request: bool, local: bool, remote: bool }
  // What a policy reply resolves to for one call: its layers and whether it
  // coalesces with other callers (C13; `coalesce: false` skips both registries).
  type Resolution = { layers: Layers, coalesce: bool }
  // The TTLs a reply resolves to, passed beside the resolution to the layered
  // traversal: the local insertion TTL, the remote frame's logical freshness
  // and the physical retention written with each remote frame. The traversal
  // relies on a precondition it does not check: a decoder derives the layers
  // from the TTLs, so `layers.local` follows from `localMs > 0` and
  // `layers.remote` from `freshMs > 0`. `layers.remote` with `freshMs` 0 is a
  // defined never-fresh miss that still counts the read and refills.
  type Ttls = { localMs: int, freshMs: int, retentionMs: int }
  // The reply of a call that uses no layer and neither registry: a caller in a
  // closed scope (C01) or, in a profile with runtime replies, an invalid leaf.
  pure val BYPASS: Resolution = { layers: { request: false, local: false, remote: false }, coalesce: false }

  pure def enabledLayers(policy: int, remoteAvailable: bool): Layers = {
    request: policy != NO_REQUEST_LAYER and policy != NO_LAYERS,
    local: Set(ALL_LAYERS, NO_REQUEST_LAYER, NO_REMOTE_LAYER).contains(policy),
    remote: remoteAvailable and Set(ALL_LAYERS, NO_REQUEST_LAYER, NO_LOCAL_LAYER).contains(policy)
  }
  pure def resolution(policy: int, remoteAvailable: bool): Resolution =
    { layers: enabledLayers(policy, remoteAvailable), coalesce: true }
  // Sharing across callers exists only where a shared layer (local or remote)
  // participates; a request-only call is never coalesced across scopes.
  pure def sharedLayers(layers: Layers): bool = layers.local or layers.remote
}
