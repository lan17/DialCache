//! Operations: the typed description of one cached call and its erased form.

use std::any::TypeId;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::codec::{Codec, JsonCodec, Payload};
use crate::error::{BoxError, Error};
use crate::identity::Identity;
use crate::limits::DEFAULT_FALLBACK_TIMEOUT_MS;
use crate::local::StoredValue;
use crate::policy::Policy;
use crate::scope::Scope;

/// The source deadline of one operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SourceBudget {
    /// The library default, 60,000 ms.
    #[default]
    Default,
    /// No deadline: the caller waits for the source however long it takes.
    /// Shadow work still uses the default budget.
    Unbounded,
    /// A deadline in whole milliseconds, `1..=2_147_483_647`.
    Millis(u64),
}

impl SourceBudget {
    pub(crate) fn millis(self) -> Option<u64> {
        match self {
            SourceBudget::Default => Some(DEFAULT_FALLBACK_TIMEOUT_MS),
            SourceBudget::Unbounded => None,
            SourceBudget::Millis(ms) => Some(ms),
        }
    }
}

/// Decides whether a source failure may be answered from the stale value
/// retained by the initial remote read.
pub type RecoveryPredicate = Arc<dyn Fn(&Error) -> bool + Send + Sync>;
/// Application equality used by shadow validation.
pub type Comparator<T> = Arc<dyn Fn(&T, &T) -> bool + Send + Sync>;
/// Produces a bounded textual preview of a value for mismatch warnings.
/// Runs through [`Runtime::spawn_blocking`](crate::Runtime::spawn_blocking)
/// after mismatch confirmation; callbacks may run on a CPU worker thread.
pub type Preview<T> = Arc<dyn Fn(&T) -> Option<String> + Send + Sync>;

/// One inline cached call: its identity, static policy, budget and codecs.
///
/// Use it directly with
/// [`DialCache::get_or_load`](crate::DialCache::get_or_load) when a stable use
/// case is declared at the call site instead of being registered.
pub struct Operation<T> {
    /// The logical identity; an empty namespace inherits the instance's.
    pub identity: Identity,
    /// Static caching policy, validated before execution.
    pub policy: Policy,
    /// The source deadline.
    pub budget: SourceBudget,
    /// Encodes and decodes values for the remote layer.
    pub codec: Arc<dyn Codec<T>>,
    /// Application equality for shadow validation.
    pub comparator: Comparator<T>,
    /// Per-operation stale-recovery classifier. `None` defers to the
    /// instance's, which by default admits only the source deadline error.
    pub should_recover: Option<RecoveryPredicate>,
    /// Renders bounded value previews for mismatch warnings; `None` logs none.
    pub preview: Option<Preview<T>>,
}

impl<T> Clone for Operation<T> {
    fn clone(&self) -> Self {
        Self {
            identity: self.identity.clone(),
            policy: self.policy.clone(),
            budget: self.budget,
            codec: self.codec.clone(),
            comparator: self.comparator.clone(),
            should_recover: self.should_recover.clone(),
            preview: self.preview.clone(),
        }
    }
}

impl<T> std::fmt::Debug for Operation<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Operation")
            .field("identity", &self.identity)
            .field("policy", &self.policy)
            .field("budget", &self.budget)
            .finish_non_exhaustive()
    }
}

impl<T: Serialize + DeserializeOwned + PartialEq + Send + Sync + 'static> Operation<T> {
    /// An operation using the JSON codec, `PartialEq` shadow comparison and
    /// JSON mismatch previews.
    pub fn new(identity: Identity) -> Self {
        Operation {
            identity,
            policy: Policy::default(),
            budget: SourceBudget::Default,
            codec: Arc::new(JsonCodec),
            comparator: Arc::new(|a: &T, b: &T| a == b),
            should_recover: None,
            preview: Some(Arc::new(crate::preview::json_preview::<T>)),
        }
    }
}

impl<T: Send + Sync + 'static> Operation<T> {
    /// An operation with an explicit codec and comparator, for values that
    /// are not `serde` JSON values. Mismatch previews are absent unless set.
    pub fn with_codec(
        identity: Identity,
        codec: Arc<dyn Codec<T>>,
        comparator: impl Fn(&T, &T) -> bool + Send + Sync + 'static,
    ) -> Self {
        Operation {
            identity,
            policy: Policy::default(),
            budget: SourceBudget::Default,
            codec,
            comparator: Arc::new(comparator),
            should_recover: None,
            preview: None,
        }
    }

    /// Replace the static policy.
    pub fn policy(mut self, policy: Policy) -> Self {
        self.policy = policy;
        self
    }

    /// Replace the source deadline.
    pub fn budget(mut self, budget: SourceBudget) -> Self {
        self.budget = budget;
        self
    }

    /// Set the stale-recovery classifier for this operation, overriding the
    /// instance's.
    pub fn should_recover(
        mut self,
        predicate: impl Fn(&Error) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.should_recover = Some(Arc::new(predicate));
        self
    }

    /// Set the mismatch-warning preview; `None` from the closure omits the value.
    pub fn preview(
        mut self,
        preview: impl Fn(&T) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        self.preview = Some(Arc::new(preview));
        self
    }

    pub(crate) fn erase(self) -> (Identity, Arc<OperationMetadata>) {
        let codec = self.codec;
        let comparator = self.comparator;
        let preview = self.preview;
        let metadata = OperationMetadata {
            value_type: TypeId::of::<T>(),
            policy: self.policy,
            budget: self.budget,
            codec: Arc::new(TypedCodec { codec }),
            compare: Arc::new(move |a: &StoredValue, b: &StoredValue| {
                let (Some(a), Some(b)) = (a.downcast_ref::<T>(), b.downcast_ref::<T>()) else {
                    return Err("shadow comparison received a value of another type".into());
                };
                Ok(comparator(a, b))
            }),
            should_recover: self.should_recover,
            preview: preview.map(|preview| {
                Arc::new(move |value: &StoredValue| {
                    value.downcast_ref::<T>().and_then(|v| preview(v))
                }) as Arc<dyn Fn(&StoredValue) -> Option<String> + Send + Sync>
            }),
        };
        (self.identity, Arc::new(metadata))
    }
}

/// Source loader over erased values.
pub(crate) type ErasedLoad =
    Arc<dyn Fn(Scope) -> BoxFuture<'static, Result<StoredValue, BoxError>> + Send + Sync>;
pub(crate) type ErasedCompare =
    Arc<dyn Fn(&StoredValue, &StoredValue) -> Result<bool, BoxError> + Send + Sync>;
pub(crate) type ErasedPreview = Arc<dyn Fn(&StoredValue) -> Option<String> + Send + Sync>;
pub(crate) type IdentityProvider = Arc<dyn Fn() -> Result<Identity, BoxError> + Send + Sync>;

/// Immutable adapters and policy, shared by every registered invocation.
pub(crate) struct OperationMetadata {
    pub value_type: TypeId,
    pub policy: Policy,
    pub budget: SourceBudget,
    pub codec: Arc<dyn ErasedCodec>,
    pub compare: ErasedCompare,
    pub should_recover: Option<RecoveryPredicate>,
    pub preview: Option<ErasedPreview>,
}

/// The type-erased operation the engine executes.
pub(crate) struct ErasedOperation {
    pub identity: Identity,
    pub identity_provider: Option<IdentityProvider>,
    pub metadata: Arc<OperationMetadata>,
    pub load: ErasedLoad,
}

/// A codec over erased values.
pub(crate) trait ErasedCodec: Send + Sync {
    fn encode<'a>(&'a self, value: &'a StoredValue) -> BoxFuture<'a, Result<Payload, BoxError>>;
    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<StoredValue, BoxError>>;
}

struct TypedCodec<T> {
    codec: Arc<dyn Codec<T>>,
}

impl<T: Send + Sync + 'static> ErasedCodec for TypedCodec<T> {
    fn encode<'a>(&'a self, value: &'a StoredValue) -> BoxFuture<'a, Result<Payload, BoxError>> {
        match value.downcast_ref::<T>() {
            Some(value) => self.codec.encode(value),
            None => Box::pin(std::future::ready(Err(
                "codec received a value of another type".into(),
            ))),
        }
    }

    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<StoredValue, BoxError>> {
        let decoding = self.codec.decode(payload);
        Box::pin(async move { decoding.await.map(|value| Arc::new(value) as StoredValue) })
    }
}

/// Erase a typed source closure.
pub(crate) fn erase_load<T, F, Fut>(load: F) -> ErasedLoad
where
    T: Send + Sync + 'static,
    F: Fn(Scope) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<T, BoxError>> + Send + 'static,
{
    Arc::new(move |scope: Scope| {
        let future = load(scope);
        Box::pin(async move { future.await.map(|value| Arc::new(value) as StoredValue) })
    })
}

/// Downcast an erased value to its typed form.
pub(crate) fn downcast_value<T: Send + Sync + 'static>(
    value: StoredValue,
) -> Result<Arc<T>, Error> {
    Arc::downcast::<T>(value).map_err(|_| {
        Error::Config(crate::error::ConfigError::invalid(format!(
            "cached value is not a {}",
            std::any::type_name::<T>()
        )))
    })
}
