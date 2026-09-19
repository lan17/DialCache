//! DialCache: explicitly enabled, layered caching with runtime rollout,
//! request coalescing, tracked invalidation, stale recovery and shadow
//! validation.
//!
//! This crate is a port of the TypeScript library. Its portable behavior is
//! defined by the Quint models under `formal/` and checked by replaying the
//! same generated histories through the real API.

#![forbid(unsafe_code)]
#![warn(missing_debug_implementations)]

pub mod cancel;
pub mod clock;
pub mod codec;
pub mod error;
pub mod identity;
pub mod limits;
pub mod local;
pub mod observe;
pub mod policy;
pub mod protocol;
pub mod remote;
pub mod spawn;

pub use cancel::CancelToken;
pub use clock::Clock;
#[cfg(feature = "tokio")]
pub use clock::SystemClock;
pub use codec::{Codec, JsonCodec, Payload, SyncCodec};
pub use error::{BoxError, ConfigError, Error, FallbackTimeout, RemoteReadTimeout, SharedError};
pub use identity::{normalize_args, ArgValue, Identity, IdentityError, Keys};
pub use local::{LocalEntry, LocalStore, LruLocalStore, StoredValue};
pub use observe::{Event, Labels, LogEvent, LogLevel, Logger, Observer, ShadowMismatchDetails};
pub use policy::{Policy, PolicyDefaults, PolicyError, ResolvedPolicy, RuntimePolicy, ShadowPolicy};
pub use remote::{Frame, InvalidateRequest, MissReason, ReadContext, ReadRequest, ReadResult, Remote, WriteRequest};
pub use spawn::Spawner;
#[cfg(feature = "tokio")]
pub use spawn::TokioSpawner;
