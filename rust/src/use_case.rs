//! Registered, typed use cases.

use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::codec::{Codec, JsonCodec};
use crate::engine::DialCache;
use crate::error::{BoxError, ConfigError, Error};
use crate::identity::{normalize_args, ArgValue, Identity, IntoKeyId};
use crate::operation::{
    downcast_value, erase_load, Comparator, ErasedOperation, Operation, OperationMetadata, Preview,
    RecoveryPredicate, SourceBudget,
};
use crate::policy::Policy;
use crate::scope::Scope;

/// The key of one call: the entity id and any secondary dimensions.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KeySpec {
    /// The entity identifier, spelled as text.
    pub id: String,
    /// Secondary dimensions; absent values are dropped and names sorted when
    /// the key is built.
    pub args: Vec<(String, ArgValue)>,
}

impl KeySpec {
    /// A key with `id` and no secondary dimensions. See [`IntoKeyId`] for
    /// the shared numeric spelling and supported input types.
    pub fn new(id: impl IntoKeyId) -> Self {
        KeySpec {
            id: id.into_key_id(),
            args: Vec::new(),
        }
    }

    /// Add a secondary key dimension. Absent values are omitted; names are
    /// sorted by UTF-16 code units when the key is built. Primitive integers
    /// preserve their exact decimal value; floats use JavaScript number
    /// spelling, with `f32` promoted to `f64`. Shared references to supported
    /// inputs are also accepted.
    pub fn arg(mut self, name: impl Into<String>, value: impl Into<ArgValue>) -> Self {
        self.args.push((name.into(), value.into()));
        self
    }
}

impl From<String> for KeySpec {
    fn from(id: String) -> Self {
        KeySpec::new(id)
    }
}

impl From<&str> for KeySpec {
    fn from(id: &str) -> Self {
        KeySpec::new(id)
    }
}

macro_rules! key_from_number {
    ($($t:ty),*) => { $(impl From<$t> for KeySpec { fn from(id: $t) -> Self { KeySpec::new(id) } })* };
}
key_from_number!(i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize, f64, f32);

impl From<&str> for ArgValue {
    fn from(value: &str) -> Self {
        ArgValue::Str(value.to_string())
    }
}

impl From<String> for ArgValue {
    fn from(value: String) -> Self {
        ArgValue::Str(value)
    }
}

impl<T: Clone + Into<ArgValue>> From<&T> for ArgValue {
    fn from(value: &T) -> Self {
        value.clone().into()
    }
}

impl From<bool> for ArgValue {
    fn from(value: bool) -> Self {
        ArgValue::Bool(value)
    }
}

macro_rules! integer_arg_value {
    ($($t:ty),*) => { $(impl From<$t> for ArgValue {
        fn from(value: $t) -> Self { ArgValue::Int(i64::from(value)) }
    })* };
}
integer_arg_value!(i8, i16, i32, i64, u8, u16, u32);

macro_rules! wide_integer_arg_value {
    ($($t:ty),*) => { $(impl From<$t> for ArgValue {
        fn from(value: $t) -> Self {
            match i64::try_from(value) {
                Ok(value) => ArgValue::Int(value),
                Err(_) => ArgValue::BigInt(value.to_string()),
            }
        }
    })* };
}
wide_integer_arg_value!(i128, isize, u64, u128, usize);

impl From<f64> for ArgValue {
    fn from(value: f64) -> Self {
        ArgValue::Number(value)
    }
}

impl From<f32> for ArgValue {
    fn from(value: f32) -> Self {
        ArgValue::Number(f64::from(value))
    }
}

impl<T: Into<ArgValue>> From<Option<T>> for ArgValue {
    fn from(value: Option<T>) -> Self {
        match value {
            Some(value) => value.into(),
            None => ArgValue::Absent,
        }
    }
}

type KeyFn<Args> = Arc<dyn Fn(&Args) -> KeySpec + Send + Sync>;
type SourceFn<Args, T> =
    Arc<dyn Fn(Scope, Args) -> BoxFuture<'static, Result<T, BoxError>> + Send + Sync>;

/// Builds a registered use case. Finish with [`register`](Self::register)
/// for `serde` JSON values or [`register_custom`](Self::register_custom)
/// with an explicit codec and comparator.
pub struct UseCaseBuilder<Args, T> {
    cache: DialCache,
    key_type: String,
    use_case: String,
    tracked: bool,
    policy: Policy,
    budget: SourceBudget,
    codec: Option<Arc<dyn Codec<T>>>,
    comparator: Option<Comparator<T>>,
    should_recover: Option<RecoveryPredicate>,
    preview: Option<Preview<T>>,
    key: Option<KeyFn<Args>>,
    source: Option<SourceFn<Args, T>>,
}

impl<Args, T> std::fmt::Debug for UseCaseBuilder<Args, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UseCaseBuilder")
            .field("key_type", &self.key_type)
            .field("use_case", &self.use_case)
            .finish_non_exhaustive()
    }
}

impl<Args, T> UseCaseBuilder<Args, T>
where
    Args: Clone + Send + Sync + 'static,
    T: Send + Sync + 'static,
{
    pub(crate) fn new(cache: DialCache, key_type: String, use_case: String) -> Self {
        UseCaseBuilder {
            cache,
            key_type,
            use_case,
            tracked: false,
            policy: Policy::default(),
            budget: SourceBudget::Default,
            codec: None,
            comparator: None,
            should_recover: None,
            preview: None,
            key: None,
            source: None,
        }
    }

    /// Static policy captured for every call of this use case.
    pub fn policy(mut self, policy: Policy) -> Self {
        self.policy = policy;
        self
    }

    /// Share the entity's invalidation watermark with every tracked variant.
    pub fn tracked(mut self, tracked: bool) -> Self {
        self.tracked = tracked;
        self
    }

    /// The source deadline. Defaults to 60 s.
    pub fn budget(mut self, budget: SourceBudget) -> Self {
        self.budget = budget;
        self
    }

    /// Replace the JSON codec; required by [`register_custom`](Self::register_custom).
    pub fn codec(mut self, codec: Arc<dyn Codec<T>>) -> Self {
        self.codec = Some(codec);
        self
    }

    /// Application equality for shadow validation. Defaults to `PartialEq`.
    pub fn comparator(
        mut self,
        comparator: impl Fn(&T, &T) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.comparator = Some(Arc::new(comparator));
        self
    }

    /// Override the instance classifier for stale recovery.
    pub fn should_recover(
        mut self,
        predicate: impl Fn(&Error) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.should_recover = Some(Arc::new(predicate));
        self
    }

    /// Bounded textual preview of a value for mismatch warnings.
    pub fn preview(
        mut self,
        preview: impl Fn(&T) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        self.preview = Some(Arc::new(preview));
        self
    }

    /// Select every input dimension that affects the value. Runs only for
    /// enabled calls.
    pub fn key(mut self, key: impl Fn(&Args) -> KeySpec + Send + Sync + 'static) -> Self {
        self.key = Some(Arc::new(key));
        self
    }

    /// The source of truth. It receives the call's scope so nested cached
    /// calls can participate; served-hit shadow validation invokes it again
    /// under disabled caching.
    pub fn source<F, Fut>(mut self, source: F) -> Self
    where
        F: Fn(Scope, Args) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<T, BoxError>> + Send + 'static,
    {
        self.source = Some(Arc::new(move |scope, args| Box::pin(source(scope, args))));
        self
    }

    fn finish(
        self,
        codec: Arc<dyn Codec<T>>,
        comparator: Comparator<T>,
        preview: Option<Preview<T>>,
    ) -> Result<UseCase<Args, T>, ConfigError> {
        let key = self
            .key
            .ok_or_else(|| ConfigError::invalid("DialCache use case needs a key selector"))?;
        let source = self
            .source
            .ok_or_else(|| ConfigError::invalid("DialCache use case needs a source"))?;
        self.policy
            .validate()
            .map_err(|e| ConfigError::invalid(e.to_string()))?;
        if let SourceBudget::Millis(ms) = self.budget {
            if !(1..=crate::limits::MAX_DEADLINE_MS).contains(&ms) {
                return Err(ConfigError::invalid(
                    "DialCache source budget is outside its domain",
                ));
            }
        }
        self.cache.register_use_case(&self.use_case)?;
        let (identity, metadata) = Operation {
            identity: Identity::new(self.key_type, "", self.use_case).tracked(self.tracked),
            policy: self.policy,
            budget: self.budget,
            codec,
            comparator,
            should_recover: self.should_recover,
            preview,
        }
        .erase();
        Ok(UseCase {
            inner: Arc::new(UseCaseInner {
                cache: self.cache,
                identity,
                metadata,
                key,
                source,
            }),
            _args: PhantomData,
        })
    }

    /// Register with an explicit codec and comparator (set with
    /// [`codec`](Self::codec) and [`comparator`](Self::comparator)).
    pub fn register_custom(self) -> Result<UseCase<Args, T>, ConfigError> {
        let codec = self
            .codec
            .clone()
            .ok_or_else(|| ConfigError::invalid("DialCache use case needs a codec"))?;
        let comparator = self
            .comparator
            .clone()
            .ok_or_else(|| ConfigError::invalid("DialCache use case needs a comparator"))?;
        let preview = self.preview.clone();
        self.finish(codec, comparator, preview)
    }
}

impl<Args, T> UseCaseBuilder<Args, T>
where
    Args: Clone + Send + Sync + 'static,
    T: Serialize + DeserializeOwned + PartialEq + Send + Sync + 'static,
{
    /// Register with the JSON codec, `PartialEq` comparison and JSON previews
    /// unless overridden.
    pub fn register(self) -> Result<UseCase<Args, T>, ConfigError> {
        let codec = self.codec.clone().unwrap_or_else(|| Arc::new(JsonCodec));
        let comparator = self
            .comparator
            .clone()
            .unwrap_or_else(|| Arc::new(|a: &T, b: &T| a == b));
        let preview = self
            .preview
            .clone()
            .or_else(|| Some(Arc::new(|value: &T| serde_json::to_string(value).ok())));
        self.finish(codec, comparator, preview)
    }
}

struct UseCaseInner<Args, T> {
    cache: DialCache,
    identity: Identity,
    metadata: Arc<OperationMetadata>,
    key: KeyFn<Args>,
    source: SourceFn<Args, T>,
}

/// A registered use case: a typed cached function.
///
/// Values are shared by reference and must be treated as immutable.
pub struct UseCase<Args, T> {
    inner: Arc<UseCaseInner<Args, T>>,
    _args: PhantomData<fn(Args)>,
}

impl<Args, T> Clone for UseCase<Args, T> {
    fn clone(&self) -> Self {
        UseCase {
            inner: self.inner.clone(),
            _args: PhantomData,
        }
    }
}

impl<Args, T> std::fmt::Debug for UseCase<Args, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UseCase")
            .field("key_type", &self.inner.identity.key_type)
            .field("use_case", &self.inner.identity.use_case)
            .finish()
    }
}

impl<Args, T> UseCase<Args, T>
where
    Args: Clone + Send + Sync + 'static,
    T: Send + Sync + 'static,
{
    /// The operation name given at registration.
    pub fn use_case(&self) -> &str {
        &self.inner.identity.use_case
    }

    /// The entity type given at registration.
    pub fn key_type(&self) -> &str {
        &self.inner.identity.key_type
    }

    /// Get the value for `args` through the configured layers.
    pub async fn get(&self, scope: &Scope, args: Args) -> Result<Arc<T>, Error> {
        let inner = self.inner.clone();
        let identity = inner.identity.clone();
        let provider_identity = identity.clone();
        let provider_args = args.clone();
        let provider_inner = inner.clone();
        let identity_provider = Arc::new(move || -> Result<Identity, BoxError> {
            let spec = (provider_inner.key)(&provider_args);
            let args = normalize_args(spec.args.clone())?;
            Ok(Identity {
                id: spec.id,
                args,
                ..provider_identity.clone()
            })
        });
        let source_inner = inner.clone();
        let load = erase_load(move |scope: Scope| (source_inner.source)(scope, args.clone()));
        let erased = ErasedOperation {
            identity,
            identity_provider: Some(identity_provider),
            metadata: inner.metadata.clone(),
            load,
        };
        let value = inner.cache.execute(scope, erased).await?;
        downcast_value::<T>(value)
    }

    /// Invoke the source directly, outside any scope. Equivalent to
    /// [`get`](Self::get) with [`Scope::outside`].
    pub async fn get_uncached(&self, args: Args) -> Result<Arc<T>, Error> {
        self.get(&Scope::outside(), args).await
    }
}

impl DialCache {
    /// Start registering a use case. `key_type` names the entity type and
    /// `use_case` the operation; the pair identifies cached values.
    pub fn use_case<Args, T>(
        &self,
        key_type: impl Into<String>,
        use_case: impl Into<String>,
    ) -> UseCaseBuilder<Args, T>
    where
        Args: Clone + Send + Sync + 'static,
        T: Send + Sync + 'static,
    {
        UseCaseBuilder::new(self.clone(), key_type.into(), use_case.into())
    }
}
