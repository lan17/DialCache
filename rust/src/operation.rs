//! Operations: the typed description of one cached call and its erased form.

use std::any::TypeId;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::codec::{Codec, JsonCodec, Payload};
use crate::error::{BoxError, Error};
use crate::identity::Identity;
use crate::limits::DEFAULT_FALLBACK_TIMEOUT_MS;
use crate::local::StoredValue;
use crate::policy::Policy;
use crate::scope::Scope;
use crate::shadow_log::JsonRender;

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
/// Renders the text a confirmed-mismatch warning logs for a value when
/// `mismatch_logging.value` is on, in place of the value's JSON. `None`, or a
/// panic, logs the field as unavailable with a `render_error` outcome. A
/// preview you set replaces the JSON for the whole warning, so the built-in
/// difference computation never reads what it leaves out: difference fields
/// then come only from a [`MismatchDiffHook`]. Runs through
/// [`Runtime::spawn_blocking`](crate::Runtime::spawn_blocking) after mismatch
/// confirmation; callbacks may run on a CPU worker thread.
pub type Preview<T> = Arc<dyn Fn(&T) -> Option<String> + Send + Sync>;
/// Replaces the built-in difference computation of confirmed-mismatch
/// warnings for one operation: receives the compared cached and source values
/// and returns the differences. Like the comparator it must be deterministic,
/// side-effect-free and bounded; a panic logs the difference fields as
/// unavailable with a `hook_error` outcome and never falls back to the
/// built-in computation. Runs through
/// [`Runtime::spawn_blocking`](crate::Runtime::spawn_blocking) after mismatch
/// confirmation, and only when `mismatch_logging.diff` is above `off`.
pub type MismatchDiffHook<T> = Arc<dyn Fn(&T, &T) -> Vec<MismatchEntry> + Send + Sync>;

/// One difference in a confirmed-mismatch warning: an RFC 6901 JSON Pointer
/// into the compared value and, optionally, what each side holds there. A
/// side is `None` when the member exists on the other side only, or when the
/// hook reports where the values differ but not what they hold.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MismatchEntry {
    /// The pointer, such as `/profile/email`; `""` is the whole value.
    pub path: String,
    /// The cached side at the pointer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<Value>,
    /// The source side at the pointer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

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
    /// Renders the value fields of mismatch warnings; see [`Preview`].
    /// [`new`](Operation::new) sets the values' JSON rendering, which also
    /// feeds the built-in difference computation. A closure you set replaces
    /// that JSON for the whole warning, so difference fields then come only
    /// from a [`mismatch_diff`](Self::mismatch_diff) hook. `None` logs no
    /// values and leaves the operation without a JSON rendering, as one built
    /// with [`with_codec`](Operation::with_codec) is: a requested value field
    /// is unavailable with a `render_error` outcome, and so are difference
    /// fields without a hook.
    pub preview: Option<Preview<T>>,
    /// Replaces the built-in difference computation of mismatch warnings.
    /// `None` runs the built-in walk over the values' JSON, which only an
    /// operation built with [`new`](Operation::new) that keeps its default
    /// [`preview`](Self::preview) has.
    pub mismatch_diff: Option<MismatchDiffHook<T>>,
    /// The JSON rendering captured where `T: Serialize` is known, and the
    /// default preview that stands for it.
    pub(crate) json: Option<JsonDefault<T>>,
}

/// The JSON rendering of an operation built where `T: Serialize` is known,
/// with the default [`Preview`] installed for it. The rendering applies while
/// `Operation::preview` still holds that preview, recognized by `Arc`
/// identity: a closure set in its place replaces the JSON, and `None` removes
/// it.
pub(crate) struct JsonDefault<T> {
    render: JsonRender,
    preview: Preview<T>,
}

impl<T: Serialize + Send + Sync + 'static> JsonDefault<T> {
    pub(crate) fn new() -> Self {
        JsonDefault {
            render: JsonRender::of::<T>(),
            preview: Arc::new(crate::preview::json_preview::<T>),
        }
    }
}

impl<T> JsonDefault<T> {
    /// The default preview, to install as `Operation::preview`.
    pub(crate) fn preview(&self) -> Preview<T> {
        self.preview.clone()
    }
}

impl<T> Clone for JsonDefault<T> {
    fn clone(&self) -> Self {
        JsonDefault {
            render: self.render,
            preview: self.preview.clone(),
        }
    }
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
            mismatch_diff: self.mismatch_diff.clone(),
            json: self.json.clone(),
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
    /// the values' JSON for mismatch warnings: its default
    /// [`preview`](Self::preview) logs that JSON as the value fields, and the
    /// built-in difference computation walks it. The JSON rendering stays
    /// when the codec or comparator is replaced afterwards; a preview you set
    /// replaces it, and `None` in place of the default removes it.
    pub fn new(identity: Identity) -> Self {
        let json = JsonDefault::new();
        Operation {
            identity,
            policy: Policy::default(),
            budget: SourceBudget::Default,
            codec: Arc::new(JsonCodec),
            comparator: Arc::new(|a: &T, b: &T| a == b),
            should_recover: None,
            preview: Some(json.preview()),
            mismatch_diff: None,
            json: Some(json),
        }
    }
}

impl<T: Send + Sync + 'static> Operation<T> {
    /// An operation with an explicit codec and comparator, for values that
    /// are not `serde` JSON values. Mismatch warnings have no JSON rendering:
    /// their value fields need a [`preview`](Self::preview) and their
    /// difference fields a [`mismatch_diff`](Self::mismatch_diff) hook, and a
    /// field logged without one is unavailable with a `render_error` outcome.
    /// A JSON renderer for such operations is tracked in
    /// <https://github.com/lan17/DialCache/issues/245>.
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
            mismatch_diff: None,
            json: None,
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

    /// Set the text mismatch warnings log for each value in place of its
    /// JSON; `None` from the closure logs the field as unavailable. Difference
    /// fields then come only from a [`mismatch_diff`](Self::mismatch_diff)
    /// hook.
    pub fn preview(
        mut self,
        preview: impl Fn(&T) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        self.preview = Some(Arc::new(preview));
        self
    }

    /// Replace the built-in difference computation of mismatch warnings; see
    /// [`MismatchDiffHook`].
    pub fn mismatch_diff(
        mut self,
        hook: impl Fn(&T, &T) -> Vec<MismatchEntry> + Send + Sync + 'static,
    ) -> Self {
        self.mismatch_diff = Some(Arc::new(hook));
        self
    }

    pub(crate) fn erase(self) -> (Identity, Arc<OperationMetadata>) {
        let codec = self.codec;
        let comparator = self.comparator;
        // The default preview stands for the JSON rendering. Any other
        // preview replaces it, and `None` leaves the operation without one.
        let (preview, json) = match (self.preview, self.json) {
            (Some(preview), Some(json)) if Arc::ptr_eq(&preview, &json.preview) => {
                (None, Some(json.render))
            }
            (preview, _) => (preview, None),
        };
        let mismatch_diff = self.mismatch_diff;
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
                }) as ErasedPreview
            }),
            mismatch_diff: mismatch_diff.map(|hook| {
                Arc::new(move |cached: &StoredValue, source: &StoredValue| {
                    match (cached.downcast_ref::<T>(), source.downcast_ref::<T>()) {
                        (Some(cached), Some(source)) => Some(hook(cached, source)),
                        _ => None,
                    }
                }) as ErasedMismatchDiff
            }),
            json,
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
/// `None` when a value is not of the operation's type.
pub(crate) type ErasedMismatchDiff =
    Arc<dyn Fn(&StoredValue, &StoredValue) -> Option<Vec<MismatchEntry>> + Send + Sync>;
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
    pub mismatch_diff: Option<ErasedMismatchDiff>,
    /// Present only while the operation keeps its default preview.
    pub json: Option<JsonRender>,
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
    fn encode(&self, value: StoredValue) -> BoxFuture<'_, Result<Payload, BoxError>>;
    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<StoredValue, BoxError>>;
}

struct TypedCodec<T> {
    codec: Arc<dyn Codec<T>>,
}

impl<T: Send + Sync + 'static> ErasedCodec for TypedCodec<T> {
    fn encode(&self, value: StoredValue) -> BoxFuture<'_, Result<Payload, BoxError>> {
        match Arc::downcast::<T>(value) {
            Ok(value) => self.codec.encode_owned(value),
            Err(_) => Box::pin(std::future::ready(Err(
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
