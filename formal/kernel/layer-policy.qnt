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

  pure def enabledLayers(policy: int, remoteAvailable: bool): Layers = {
    request: policy != NO_REQUEST_LAYER and policy != NO_LAYERS,
    local: Set(ALL_LAYERS, NO_REQUEST_LAYER, NO_REMOTE_LAYER).contains(policy),
    remote: remoteAvailable and Set(ALL_LAYERS, NO_REQUEST_LAYER, NO_LOCAL_LAYER).contains(policy)
  }
  // Sharing across callers exists only where a shared layer (local or remote)
  // participates; a request-only call is never coalesced across scopes.
  pure def sharedLayers(layers: Layers): bool = layers.local or layers.remote
}
