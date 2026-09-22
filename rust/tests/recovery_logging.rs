//! Recovery diagnostics must not disclose retained values through the default logger.
use dialcache::observe::LogFacadeLogger;
use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    BoxError, DialCache, Frame, Identity, InvalidateRequest, LogEvent, Logger, Operation, Payload,
    Policy, ReadContext, ReadRequest, ReadResult, Remote, WriteRequest,
};
use futures::future::BoxFuture;
use std::future::ready;
use std::sync::{Arc, Mutex};

const SECRET: &str = "private-retained-token-7f61";
struct Capture(Mutex<Vec<String>>);
impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0.lock().unwrap().push(record.args().to_string());
    }
    fn flush(&self) {}
}
static CAPTURE: Capture = Capture(Mutex::new(Vec::new()));

#[derive(Default)]
struct DetailedLogger(Mutex<Vec<String>>);
impl Logger for DetailedLogger {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::RecoveryDecodeFailed(error) = event {
            let error = error
                .downcast_ref::<serde_json::Error>()
                .expect("original codec error");
            self.0.lock().unwrap().push(error.to_string());
        }
    }
}
struct RetainedString;
impl Remote for RetainedString {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(ReadResult::Hit(Frame {
            created_at_ms: WALL_EPOCH_MS as u64 - 1500,
            payload: Payload::text(serde_json::to_string(SECRET).unwrap()),
        }))))
    }
    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        panic!("failed recovery must not write a value")
    }
    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        panic!("no invalidation requested")
    }
}
#[derive(Debug, thiserror::Error)]
#[error("source unavailable")]
struct SourceFailure(Arc<()>);

#[test]
fn recovery_warning_omits_cached_values_and_preserves_structured_errors() {
    log::set_logger(&CAPTURE).unwrap();
    log::set_max_level(log::LevelFilter::Warn);
    for custom_logger in [false, true] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let detailed = Arc::new(DetailedLogger::default());
        let mut builder = DialCache::builder()
            .runtime_arc(executor.runtime.clone())
            .clock_arc(executor.clock.clone())
            .remote(RetainedString);
        if custom_logger {
            builder = builder.logger_arc(detailed.clone());
        }
        let cache = builder.build().unwrap();
        let marker = Arc::new(());
        let source_marker = marker.clone();
        let error = executor.block_on(async move {
            let request = cache.enable_guard();
            cache
                .get_or_load(
                    request.scope(),
                    Operation::<u64>::new(Identity::new("thing", "one", "PrivateRecovery"))
                        .policy(
                            Policy::default()
                                .remote_ttl_sec(1)
                                .stale_on_error_max_age_sec(10),
                        )
                        .should_recover(|_| true),
                    move |_| {
                        ready(Err(
                            Box::new(SourceFailure(source_marker.clone())) as BoxError
                        ))
                    },
                )
                .await
                .expect_err("incompatible retained value must preserve source failure")
        });
        let original = error
            .source_error()
            .unwrap()
            .downcast_ref::<SourceFailure>()
            .unwrap();
        assert!(Arc::ptr_eq(&original.0, &marker));
        if custom_logger {
            let details = detailed.0.lock().unwrap();
            assert_eq!(details.len(), 1);
            assert!(
                details[0].contains(SECRET),
                "explicit logger retains original diagnostic"
            );
        } else {
            let messages = CAPTURE.0.lock().unwrap();
            assert_eq!(messages.len(), 1, "actual default warning must be emitted");
            assert!(
                !messages[0].contains(SECRET),
                "cached value leaked: {}",
                messages[0]
            );
            assert!(messages[0].contains("JSON Data"));
            assert!(messages[0].contains("line 1"));
        }
    }
    // Arbitrary codec errors may also contain values: the default representation
    // cannot trust their Display implementation even without JSON metadata.
    LogFacadeLogger.log(&LogEvent::RecoveryDecodeFailed(SECRET.into()));
    let messages = CAPTURE.0.lock().unwrap();
    assert_eq!(messages.len(), 2);
    assert!(!messages[1].contains(SECRET));
}
