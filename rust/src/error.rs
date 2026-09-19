//! Public error types.

use std::fmt;
use std::sync::Arc;

/// Boxed error returned by sources, codecs, providers and adapters.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;
/// Shared error handed to every caller that joined one execution.
pub type SharedError = Arc<dyn std::error::Error + Send + Sync + 'static>;

/// Every failure a cached call or maintenance operation can report.
///
/// Cache plumbing fails open, so a call fails only when its source fails,
/// its source deadline elapses, a callback panics, or static configuration
/// is rejected before execution. Maintenance operations surface their own
/// remote failures.
#[derive(Debug, Clone)]
pub enum Error {
    /// The source returned an error. Every coalesced caller receives the same
    /// shared error, so identity comparisons through [`Arc::ptr_eq`] work.
    Source(SharedError),
    /// The source did not settle before its deadline. Followers of one
    /// execution share the leader's error instance.
    FallbackTimeout(Arc<FallbackTimeout>),
    /// A source, codec, provider or comparator panicked.
    Panic(Arc<str>),
    /// Static operation or instance configuration was rejected before execution.
    Config(ConfigError),
    /// Invalidation was requested without a configured remote adapter.
    MissingRemote,
    /// An explicit maintenance mutation failed at the remote adapter.
    Remote(SharedError),
}

impl Error {
    /// The source error, when the source itself failed.
    pub fn source_error(&self) -> Option<&(dyn std::error::Error + Send + Sync + 'static)> {
        match self {
            Error::Source(error) => Some(error.as_ref()),
            _ => None,
        }
    }

    /// Whether this is a source deadline error: the library's own, or one a
    /// source propagated from a nested cached call.
    pub fn is_fallback_timeout(&self) -> bool {
        match self {
            Error::FallbackTimeout(_) => true,
            Error::Source(error) => error.downcast_ref::<FallbackTimeout>().is_some(),
            _ => false,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Source(error) => write!(f, "DialCache source failed: {error}"),
            Error::FallbackTimeout(timeout) => timeout.fmt(f),
            Error::Panic(message) => write!(f, "DialCache callback panicked: {message}"),
            Error::Config(error) => error.fmt(f),
            Error::MissingRemote => {
                f.write_str("DialCache invalidation requires a configured remote adapter")
            }
            Error::Remote(error) => write!(f, "DialCache remote maintenance failed: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Source(error) | Error::Remote(error) => Some(error.as_ref()),
            Error::FallbackTimeout(timeout) => Some(timeout.as_ref()),
            Error::Config(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ConfigError> for Error {
    fn from(error: ConfigError) -> Self {
        Error::Config(error)
    }
}

/// The source deadline elapsed before the source settled.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("DialCache fallback for use case {use_case:?} timed out after {timeout_ms} ms")]
pub struct FallbackTimeout {
    /// The use case whose source timed out.
    pub use_case: String,
    /// The source budget that elapsed, in milliseconds.
    pub timeout_ms: u64,
}

/// The remote read deadline elapsed before the adapter answered.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("DialCache remote read for use case {use_case:?} timed out after {timeout_ms} ms")]
pub struct RemoteReadTimeout {
    /// The use case whose remote read timed out.
    pub use_case: String,
    /// The read budget that elapsed, in milliseconds.
    pub timeout_ms: u64,
}

/// Static configuration rejected at construction or registration.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    /// A value is outside its domain; the message names it.
    #[error("{0}")]
    Invalid(String),
    /// The use case name `watermark` is owned by invalidation.
    #[error("DialCache use case name is reserved: {0}")]
    ReservedUseCase(String),
    /// A use case with this name is already registered on the instance.
    #[error("DialCache use case already registered: {0}")]
    UseCaseAlreadyRegistered(String),
}

impl ConfigError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        ConfigError::Invalid(message.into())
    }
}
