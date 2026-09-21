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
  // The TTLs a reply resolves to, passed beside the resolution to the
  // traversal: the local insertion TTL, the remote frame's logical freshness
  // and the physical retention written with each remote frame. A layer whose
  // TTL is 0 is off (`gated`), and a source refills the remote layer iff it
  // captured a positive retention: a reply with `freshMs > 0` and
  // `retentionMs` 0 reads the remote layer and never refills it. That region
  // is not native configuration: a positive staleOnErrorMaxAgeSec must exceed
  // ttlSec.remote, and every profile decoder keeps retention at or above
  // freshness (including policy overlays' fallback for invalid recovery ages).
  type Ttls = { localMs: int, freshMs: int, retentionMs: int }
  // The TTLs of a call that uses no layer: the bypass reply's.
  pure val NO_TTLS: Ttls = { localMs: 0, freshMs: 0, retentionMs: 0 }
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
  // The layers a reply uses with its TTLs: local storage only for a positive
  // local TTL and the remote layer only for a positive freshness (the request
  // memo has no TTL). Sharing follows from the gated layers.
  pure def gated(resolved: Resolution, ttls: Ttls): Resolution = {
    layers: {
      request: resolved.layers.request,
      local: resolved.layers.local and ttls.localMs > 0,
      remote: resolved.layers.remote and ttls.freshMs > 0
    },
    coalesce: resolved.coalesce
  }
  // The TTLs of the layers a reply uses: a layer the reply leaves off has TTL
  // 0, so after this a TTL is positive exactly when its layer is on. A
  // traversal suspended at the remote layer (a held read) carries these
  // instead of the resolution: `localMs > 0` says local participates,
  // `freshMs` judges the frame at settlement, `retentionMs` is the refill
  // retention and the recovery maximum.
  pure def effectiveTtls(resolved: Resolution, ttls: Ttls): Ttls = {
    localMs: if (resolved.layers.local) ttls.localMs else 0,
    freshMs: if (resolved.layers.remote) ttls.freshMs else 0,
    retentionMs: if (resolved.layers.remote) ttls.retentionMs else 0
  }
  // Sharing across callers exists only where a shared layer (local or remote)
  // participates; a request-only call is never coalesced across scopes.
  pure def sharedLayers(layers: Layers): bool = layers.local or layers.remote
}
