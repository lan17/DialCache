//! The cache instance: construction, scopes, maintenance and call admission.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::num::NonZeroUsize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures::future::BoxFuture;
use parking_lot::Mutex;

use crate::clock::Clock;
use crate::error::{BoxError, ConfigError, Error};
use crate::flight::{start_pending, Flight, Settled, ValueResult};
use crate::identity::{Identity, IntoKeyId};
use crate::limits::{
    DEFAULT_LOCAL_CAPACITY, DEFAULT_REMOTE_READ_TIMEOUT_MS, DEFAULT_SHADOW_MAX_IN_FLIGHT,
    MAX_DEADLINE_MS, MAX_SAFE_INTEGER, MAX_SUPPORTED_DURATION_MS, WATERMARK_USE_CASE,
};
use crate::local::{LocalEntry, LocalRead, LocalStore, LruLocalStore, StoredValue};
use crate::observe::{Event, Labels, Layer, LogEvent, Logger, Observer, OutcomeLabels};
use crate::operation::{downcast_value, erase_load, ErasedOperation, Operation, RecoveryPredicate};
use crate::policy::RuntimePolicy;
use crate::protocol::CompressionConfig;
use crate::remote::{InvalidateRequest, Remote};
use crate::runtime::Runtime;
use crate::scope::{Owner, Scope};
use crate::shadow::ShadowFlight;

/// Resolves a sparse runtime policy overlay once per enabled call.
pub type PolicyProvider = Arc<
    dyn Fn(Identity) -> BoxFuture<'static, Result<Option<RuntimePolicy>, BoxError>> + Send + Sync,
>;

static NEXT_CACHE_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct CoreState {
    pub(crate) local: Option<Box<dyn LocalStore>>,
    pub(crate) flights: HashMap<String, Arc<Flight>>,
    pub(crate) shadows: HashMap<String, Arc<ShadowFlight>>,
    pub(crate) registered: HashSet<String>,
}

pub(crate) struct Core {
    pub(crate) id: u64,
    pub(crate) namespace: Arc<str>,
    pub(crate) remote: Option<Arc<dyn Remote>>,
    pub(crate) observer: Option<Arc<dyn Observer>>,
    pub(crate) logger: Arc<dyn Logger>,
    pub(crate) provider: Option<PolicyProvider>,
    pub(crate) remote_read_timeout_ms: u64,
    pub(crate) shadow_max_in_flight: usize,
    pub(crate) should_recover: Option<RecoveryPredicate>,
    /// `None` disables new compressed writes; reads still decompress.
    pub(crate) compression: Option<CompressionConfig>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) runtime: Arc<dyn Runtime>,
    pub(crate) state: Mutex<CoreState>,
}

impl Core {
    /// Deliver a diagnostic. Observer failures never change results.
    pub(crate) fn emit(&self, event: Event) {
        if let Some(observer) = &self.observer {
            let _ = catch_unwind(AssertUnwindSafe(|| observer.observe(&event)));
        }
    }

    pub(crate) fn log(&self, event: LogEvent) {
        let _ = catch_unwind(AssertUnwindSafe(|| self.logger.log(&event)));
    }

    pub(crate) fn shadow_hook_enabled(&self) -> bool {
        match &self.observer {
            Some(observer) => {
                catch_unwind(AssertUnwindSafe(|| observer.observes_shadow_outcomes()))
                    .unwrap_or(false)
            }
            None => false,
        }
    }

    /// Read a live local entry, promoting it. `Ok(None)` is a miss.
    pub(crate) fn local_get(&self, key: &str) -> Result<Option<StoredValue>, BoxError> {
        // Read the clock before taking the lock: it is the only external code
        // on this path, and a failure must not poison shared state.
        let now_ms = self.clock.elapsed_ms();
        let read = {
            let mut state = self.state.lock();
            match state.local.as_mut() {
                None => return Ok(None),
                Some(local) => catch_unwind(AssertUnwindSafe(|| local.get(key, now_ms)))
                    .unwrap_or_else(|payload| {
                        Err(crate::flight::panic_message(payload).to_string().into())
                    }),
            }
        };
        // An expired entry drops here, outside the lock: a value's destructor
        // may call back into the cache.
        match read? {
            LocalRead::Live(value) => Ok(Some(value)),
            LocalRead::Absent | LocalRead::Expired(_) => Ok(None),
        }
    }

    pub(crate) fn local_put(
        &self,
        key: &str,
        value: StoredValue,
        ttl_ms: u64,
    ) -> Result<(), BoxError> {
        let now_ms = self.clock.elapsed_ms();
        let displaced = {
            let mut state = self.state.lock();
            match state.local.as_mut() {
                None => return Ok(()),
                Some(local) => {
                    let entry = LocalEntry {
                        value,
                        inserted_ms: now_ms,
                        ttl_ms: ttl_ms.min(i64::MAX as u64) as i64,
                    };
                    catch_unwind(AssertUnwindSafe(|| local.put(key.to_string(), entry)))
                        .unwrap_or_else(|payload| {
                            Err(crate::flight::panic_message(payload).to_string().into())
                        })
                }
            }
        };
        // The displaced entry drops here, outside the lock.
        displaced.map(|_| ())
    }
}

/// Exact process-scoped single-flight state of one instance.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProcessCoalescingState {
    /// Executions currently in flight on this instance, one per logical key.
    pub active_leaders: usize,
    /// Callers currently waiting on those executions instead of running their own.
    pub active_followers: usize,
    /// Milliseconds since the oldest in-flight execution started; `None`
    /// when nothing is in flight.
    pub oldest_leader_age_ms: Option<u64>,
}

/// A point-in-time snapshot of cache-owned coalescing state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CoalescingState {
    /// Instance-wide single-flight state; request-scoped flights are not counted.
    pub process: ProcessCoalescingState,
}

/// Configures a [`DialCache`].
pub struct DialCacheBuilder {
    namespace: String,
    remote: Option<Arc<dyn Remote>>,
    observer: Option<Arc<dyn Observer>>,
    logger: Option<Arc<dyn Logger>>,
    provider: Option<PolicyProvider>,
    local_capacity: Option<usize>,
    local_store: Option<Box<dyn LocalStore>>,
    remote_read_timeout_ms: Option<u64>,
    shadow_max_in_flight: Option<usize>,
    should_recover: Option<RecoveryPredicate>,
    compression: Option<Option<CompressionConfig>>,
    clock: Option<Arc<dyn Clock>>,
    runtime: Option<Arc<dyn Runtime>>,
}

impl std::fmt::Debug for DialCacheBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialCacheBuilder")
            .field("namespace", &self.namespace)
            .finish_non_exhaustive()
    }
}

impl DialCacheBuilder {
    fn new() -> Self {
        DialCacheBuilder {
            namespace: "urn".to_string(),
            remote: None,
            observer: None,
            logger: None,
            provider: None,
            local_capacity: None,
            local_store: None,
            remote_read_timeout_ms: None,
            shadow_max_in_flight: None,
            should_recover: None,
            compression: None,
            clock: None,
            runtime: None,
        }
    }

    /// Logical namespace used in keys, invalidation identity, cohorts and
    /// labels. Defaults to `"urn"`; may not contain `{` or `}`.
    pub fn namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = namespace.into();
        self
    }

    /// The remote layer adapter. Without one, only request and local layers serve.
    pub fn remote(mut self, remote: impl Remote) -> Self {
        self.remote = Some(Arc::new(remote));
        self
    }

    /// The remote layer adapter, shared.
    pub fn remote_arc(mut self, remote: Arc<dyn Remote>) -> Self {
        self.remote = Some(remote);
        self
    }

    /// Receives every public diagnostic; also the shadow outcome hook.
    pub fn observer(mut self, observer: impl Observer) -> Self {
        self.observer = Some(Arc::new(observer));
        self
    }

    /// Receives every public diagnostic, shared.
    pub fn observer_arc(mut self, observer: Arc<dyn Observer>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Receives structured log events. Defaults to the `log` crate facade
    /// under target `dialcache`.
    pub fn logger(mut self, logger: impl Logger) -> Self {
        self.logger = Some(Arc::new(logger));
        self
    }

    /// Receives structured log events, shared.
    pub fn logger_arc(mut self, logger: Arc<dyn Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Runtime policy overlay resolved once per enabled call. `Ok(None)`
    /// inherits the operation policy; an error bypasses caching for that call.
    pub fn policy_provider<F, Fut>(mut self, provider: F) -> Self
    where
        F: Fn(Identity) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<RuntimePolicy>, BoxError>> + Send + 'static,
    {
        self.provider = Some(Arc::new(move |identity| Box::pin(provider(identity))));
        self
    }

    /// Maximum process-local entries across every use case. Zero disables
    /// local storage while preserving coalescing. Defaults to 10,000.
    pub fn local_capacity(mut self, capacity: usize) -> Self {
        self.local_capacity = Some(capacity);
        self
    }

    /// Replace the default LRU store. Advanced: the store must preserve the
    /// documented LRU, expiry and promotion rules.
    pub fn local_store(mut self, store: Box<dyn LocalStore>) -> Self {
        self.local_store = Some(store);
        self
    }

    /// Instance default remote read budget. Defaults to 50 ms.
    pub fn remote_read_timeout_ms(mut self, ms: u64) -> Self {
        self.remote_read_timeout_ms = Some(ms);
        self
    }

    /// Concurrent shadow jobs per instance; excess work is dropped. Defaults to 1.
    pub fn shadow_max_in_flight(mut self, jobs: usize) -> Self {
        self.shadow_max_in_flight = Some(jobs);
        self
    }

    /// Instance default classifier deciding whether a source failure may use
    /// a retained stale value. Omission admits only the source deadline error.
    pub fn should_recover(
        mut self,
        predicate: impl Fn(&Error) -> bool + Send + Sync + 'static,
    ) -> Self {
        self.should_recover = Some(Arc::new(predicate));
        self
    }

    /// Write-side compression policy. Enabled by default at a 4,096-byte threshold.
    pub fn compression(mut self, config: CompressionConfig) -> Self {
        self.compression = Some(Some(config));
        self
    }

    /// Store every payload uncompressed. Reads still accept compressed entries.
    pub fn disable_compression(mut self) -> Self {
        self.compression = Some(None);
        self
    }

    /// Replace the wall and elapsed clock. Defaults to
    /// [`SystemClock`](crate::SystemClock).
    pub fn clock(mut self, clock: impl Clock) -> Self {
        self.clock = Some(Arc::new(clock));
        self
    }

    /// Share a clock between instances (for example a controlled test clock).
    pub fn clock_arc(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = Some(clock);
        self
    }

    /// Share a runtime between instances.
    pub fn runtime_arc(mut self, runtime: Arc<dyn Runtime>) -> Self {
        self.runtime = Some(runtime);
        self
    }

    /// Replace the executor and timer source. Defaults to tokio.
    pub fn runtime(mut self, runtime: impl Runtime) -> Self {
        self.runtime = Some(Arc::new(runtime));
        self
    }

    /// Validate the configuration and create the instance. Rejects a
    /// namespace containing `{` or `}`, a read budget outside
    /// `1..=2_147_483_647` ms, a zero shadow cap, an invalid compression
    /// config, or no usable runtime: with the `tokio` feature, no tokio
    /// runtime is current and none was supplied through `runtime` or
    /// `runtime_arc`; without it, no runtime was supplied.
    pub fn build(self) -> Result<DialCache, ConfigError> {
        if self.namespace.contains(['{', '}']) {
            return Err(ConfigError::invalid(
                "DialCache namespace must not contain \"{\" or \"}\"",
            ));
        }
        let compression = match self.compression {
            None => Some(CompressionConfig::default()),
            Some(None) => None,
            Some(Some(config)) => {
                config
                    .validate()
                    .map_err(|e| ConfigError::invalid(e.to_string()))?;
                Some(config)
            }
        };
        let remote_read_timeout_ms = self
            .remote_read_timeout_ms
            .unwrap_or(DEFAULT_REMOTE_READ_TIMEOUT_MS);
        if !(1..=MAX_DEADLINE_MS).contains(&remote_read_timeout_ms) {
            return Err(ConfigError::invalid(format!(
                "DialCache remote read timeout must be a positive integer no greater than {MAX_DEADLINE_MS} ms"
            )));
        }
        let shadow_max_in_flight = self
            .shadow_max_in_flight
            .unwrap_or(DEFAULT_SHADOW_MAX_IN_FLIGHT);
        if shadow_max_in_flight == 0 {
            return Err(ConfigError::invalid(
                "DialCache shadow_max_in_flight must be positive",
            ));
        }
        let local: Option<Box<dyn LocalStore>> = match self.local_store {
            Some(store) => Some(store),
            None => {
                let capacity = self.local_capacity.unwrap_or(DEFAULT_LOCAL_CAPACITY);
                if capacity as u64 > MAX_SAFE_INTEGER {
                    return Err(ConfigError::invalid(
                        "DialCache local capacity must be a safe integer",
                    ));
                }
                NonZeroUsize::new(capacity)
                    .map(|capacity| Box::new(LruLocalStore::new(capacity)) as Box<dyn LocalStore>)
            }
        };
        let clock = match self.clock {
            Some(clock) => clock,
            None => default_clock()?,
        };
        let runtime = match self.runtime {
            Some(runtime) => runtime,
            None => default_runtime()?,
        };
        let core = Core {
            id: NEXT_CACHE_ID.fetch_add(1, Ordering::Relaxed),
            namespace: Arc::from(self.namespace.as_str()),
            remote: self.remote,
            observer: self.observer,
            logger: self
                .logger
                .unwrap_or_else(|| Arc::new(crate::observe::LogFacadeLogger)),
            provider: self.provider,
            remote_read_timeout_ms,
            shadow_max_in_flight,
            should_recover: self.should_recover,
            compression,
            clock,
            runtime,
            state: Mutex::new(CoreState {
                local,
                flights: HashMap::new(),
                shadows: HashMap::new(),
                registered: HashSet::new(),
            }),
        };
        Ok(DialCache {
            core: Arc::new(core),
        })
    }
}

fn default_clock() -> Result<Arc<dyn Clock>, ConfigError> {
    Ok(Arc::new(crate::clock::SystemClock::new()))
}

#[cfg(feature = "tokio")]
fn default_runtime() -> Result<Arc<dyn Runtime>, ConfigError> {
    Ok(Arc::new(crate::runtime::TokioRuntime::current()?))
}

#[cfg(not(feature = "tokio"))]
fn default_runtime() -> Result<Arc<dyn Runtime>, ConfigError> {
    Err(ConfigError::invalid("DialCache needs a runtime: enable the tokio feature or supply one with DialCacheBuilder::runtime"))
}

/// Holds the outermost enabled scope open until dropped.
#[derive(Debug)]
pub struct ScopeGuard {
    scope: Scope,
    owner: Arc<Owner>,
}

impl ScopeGuard {
    /// The enabled scope of this request.
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        self.owner.close();
    }
}

/// A cache instance: request, process-local and remote layers behind explicit enablement.
///
/// Instances are cheap to clone and share one state.
#[derive(Clone)]
pub struct DialCache {
    pub(crate) core: Arc<Core>,
}

impl std::fmt::Debug for DialCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialCache")
            .field("namespace", &self.core.namespace)
            .finish_non_exhaustive()
    }
}

impl DialCache {
    /// Start configuring an instance with the defaults documented on
    /// [`DialCacheBuilder`]'s setters.
    pub fn builder() -> DialCacheBuilder {
        DialCacheBuilder::new()
    }

    /// The instance namespace.
    pub fn namespace(&self) -> &str {
        &self.core.namespace
    }

    /// Open the outermost enabled scope and hold it in a guard. The scope
    /// closes when the guard drops; retained [`Scope`] clones then pass through.
    ///
    /// ```ignore
    /// let request = cache.enable_guard();
    /// let name = display_name.get(request.scope(), id).await?;
    /// ```
    pub fn enable_guard(&self) -> ScopeGuard {
        let owner = Owner::new();
        let scope = Scope {
            cache_id: self.core.id,
            owner: Some(owner.clone()),
            enabled: true,
        };
        ScopeGuard { scope, owner }
    }

    /// Open the outermost enabled scope for `f`. The scope closes when the
    /// returned future completes, is dropped before completion, or unwinds;
    /// retained clones then pass through.
    pub async fn enable<F, Fut, R>(&self, f: F) -> R
    where
        F: FnOnce(Scope) -> Fut,
        Fut: Future<Output = R>,
    {
        let guard = self.enable_guard();
        let scope = guard.scope().clone();
        let result = f(scope).await;
        drop(guard);
        result
    }

    /// Enable caching inside `parent`, reusing its live outer request memo.
    /// When `parent` has no live outer scope, this opens a new one.
    pub async fn enable_in<F, Fut, R>(&self, parent: &Scope, f: F) -> R
    where
        F: FnOnce(Scope) -> Fut,
        Fut: Future<Output = R>,
    {
        let live = if parent.cache_id == self.core.id {
            parent.live_owner()
        } else {
            None
        };
        match live {
            Some(owner) => {
                let scope = Scope {
                    cache_id: self.core.id,
                    owner: Some(owner),
                    enabled: true,
                };
                f(scope).await
            }
            None => self.enable(f).await,
        }
    }

    /// Disable caching inside `parent` while preserving its outer request memo
    /// for nested re-enablement.
    pub async fn disable_in<F, Fut, R>(&self, parent: &Scope, f: F) -> R
    where
        F: FnOnce(Scope) -> Fut,
        Fut: Future<Output = R>,
    {
        let owner = if parent.cache_id == self.core.id {
            parent.owner.clone()
        } else {
            None
        };
        let scope = Scope {
            cache_id: self.core.id,
            owner,
            enabled: false,
        };
        f(scope).await
    }

    /// Whether calls made with `scope` on this instance use caching.
    pub fn is_enabled(&self, scope: &Scope) -> bool {
        scope.cache_id == self.core.id && scope.is_enabled()
    }

    /// Process-scoped single-flight state of this instance.
    pub fn coalescing_state(&self) -> CoalescingState {
        let now = self.core.clock.elapsed();
        let state = self.core.state.lock();
        let mut process = ProcessCoalescingState {
            active_leaders: state.flights.len(),
            ..Default::default()
        };
        for flight in state.flights.values() {
            process.active_followers += flight.followers();
            let age = now
                .saturating_sub(flight.started)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            if process
                .oldest_leader_age_ms
                .is_none_or(|oldest| age > oldest)
            {
                process.oldest_leader_age_ms = Some(age);
            }
        }
        CoalescingState { process }
    }

    /// Advance the invalidation watermark of every tracked variant of one
    /// entity, in this instance's namespace. Call it after the source
    /// mutation commits. Requires a remote adapter; failures are returned.
    /// IDs use the same [`IntoKeyId`] conversion as [`crate::KeySpec::new`].
    pub async fn invalidate(
        &self,
        key_type: &str,
        id: impl IntoKeyId,
        future_buffer_ms: u64,
    ) -> Result<(), Error> {
        let identity = Identity::new(key_type, id.into_key_id(), WATERMARK_USE_CASE)
            .tracked(true)
            .namespace(self.core.namespace.to_string());
        self.invalidate_identity(identity, future_buffer_ms).await
    }

    /// Advance the watermark for the entity named by `identity` after its
    /// source mutation commits. An empty namespace inherits this instance's;
    /// an explicit namespace is preserved, exactly as in `get_or_load`.
    ///
    /// All use cases and argument variants share the entity's watermark.
    /// `tracked` is ignored: this operation always invalidates tracked remote
    /// values. Local entries and already acquired snapshots retain their lifetimes.
    /// Requires a remote adapter; mutation failures are returned to the caller.
    pub async fn invalidate_identity(
        &self,
        mut identity: Identity,
        future_buffer_ms: u64,
    ) -> Result<(), Error> {
        let core = &self.core;
        if future_buffer_ms > MAX_SUPPORTED_DURATION_MS {
            return Err(ConfigError::invalid(
                "DialCache invalidation future buffer must be no greater than 365 days",
            )
            .into());
        }
        if identity.namespace.is_empty() {
            identity.namespace = core.namespace.to_string();
        }
        identity.tracked = true;
        let namespace: Arc<str> = Arc::from(identity.namespace.as_str());
        let key_type: Arc<str> = Arc::from(identity.key_type.as_str());
        core.emit(Event::Invalidation {
            namespace: namespace.clone(),
            key_type: key_type.clone(),
            layer: Layer::Remote,
        });
        let result: Result<(), Error> = async {
            let remote = core.remote.clone().ok_or(Error::MissingRemote)?;
            let keys = identity
                .keys()
                .map_err(|e| Error::Config(ConfigError::invalid(e.to_string())))?;
            let watermark_key = keys.watermark.ok_or_else(|| {
                Error::Config(ConfigError::invalid(
                    "tracked identity has no watermark key",
                ))
            })?;
            let now = core.clock.wall_ms();
            if now < 0 || now as u64 > MAX_SAFE_INTEGER - future_buffer_ms {
                return Err(ConfigError::invalid(
                    "DialCache invalidation timestamp is outside the safe integer domain",
                )
                .into());
            }
            let request = InvalidateRequest {
                watermark_key,
                invalidated_at_ms: now as u64,
                future_buffer_ms,
            };
            let pending: Settled<Result<(), Error>> = start_pending(
                core.runtime.as_ref(),
                async move {
                    remote
                        .invalidate(request)
                        .await
                        .map_err(|e| Error::Remote(Arc::from(e)))
                },
                |message| Err(Error::Panic(message)),
            );
            pending.wait().await
        }
        .await;
        if let Err(error) = &result {
            core.log(LogEvent::InvalidationFailed(error.to_string().into()));
            core.emit(Event::Error {
                labels: Labels {
                    namespace,
                    use_case: Arc::from(WATERMARK_USE_CASE),
                    key_type,
                    layer: Layer::Remote,
                },
                error: crate::observe::ErrorKind::Invalidation,
                in_fallback: false,
            });
        }
        result
    }

    /// Execute one inline cached call.
    ///
    /// `load` is the source of truth; it may be invoked again later by
    /// served-hit shadow validation, so it must be reusable. The returned
    /// value is shared by reference: treat it as immutable.
    pub async fn get_or_load<T, F, Fut>(
        &self,
        scope: &Scope,
        operation: Operation<T>,
        load: F,
    ) -> Result<Arc<T>, Error>
    where
        T: Send + Sync + 'static,
        F: Fn(Scope) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<T, BoxError>> + Send + 'static,
    {
        let (identity, metadata) = operation.erase();
        let erased = ErasedOperation {
            identity,
            identity_provider: None,
            metadata,
            load: erase_load(load),
        };
        let value = self.execute(scope, erased).await?;
        downcast_value::<T>(value)
    }

    /// Validate static operation configuration, then run the execution as
    /// detached work whose result every caller awaits. Dropping the returned
    /// future does not cancel the execution: sources and publications keep
    /// their contracts, as in the reference implementations.
    pub(crate) async fn execute(
        &self,
        scope: &Scope,
        mut operation: ErasedOperation,
    ) -> ValueResult {
        validate_operation(&operation)?;
        if operation.identity.namespace.is_empty() {
            operation.identity.namespace = self.core.namespace.to_string();
        }
        // A scope owned by another instance disables this call but still
        // reaches the source, so nested calls on its own instance keep caching.
        let core = self.core.clone();
        let scope = scope.clone();
        let pending: Settled<ValueResult> = start_pending(
            core.runtime.clone().as_ref(),
            crate::execution::run(core, scope, Arc::new(operation)),
            |message| Err(Error::Panic(message)),
        );
        pending.wait().await
    }

    pub(crate) fn register_use_case(&self, use_case: &str) -> Result<(), ConfigError> {
        if use_case == WATERMARK_USE_CASE {
            return Err(ConfigError::ReservedUseCase(use_case.to_string()));
        }
        let mut state = self.core.state.lock();
        if !state.registered.insert(use_case.to_string()) {
            return Err(ConfigError::UseCaseAlreadyRegistered(use_case.to_string()));
        }
        Ok(())
    }
}

pub(crate) fn validate_operation(operation: &ErasedOperation) -> Result<(), Error> {
    operation
        .metadata
        .policy
        .validate()
        .map_err(|e| ConfigError::invalid(e.to_string()))?;
    if let crate::operation::SourceBudget::Millis(ms) = operation.metadata.budget {
        if !(1..=MAX_DEADLINE_MS).contains(&ms) {
            return Err(ConfigError::invalid(format!(
                "DialCache source budget must be a positive integer no greater than {MAX_DEADLINE_MS} ms"
            ))
            .into());
        }
    }
    if operation.identity.use_case == WATERMARK_USE_CASE {
        return Err(ConfigError::ReservedUseCase(operation.identity.use_case.clone()).into());
    }
    Ok(())
}

pub(crate) fn outcome_labels(identity: &Identity) -> OutcomeLabels {
    OutcomeLabels {
        namespace: Arc::from(identity.namespace.as_str()),
        use_case: Arc::from(identity.use_case.as_str()),
        key_type: Arc::from(identity.key_type.as_str()),
    }
}
