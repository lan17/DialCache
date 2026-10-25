//! Exercise the actual default log facade, including the optional mismatch fields.
use dialcache::observe::{LogFacadeLogger, ShadowMismatchLoggingOutcome};
use dialcache::{
    LogEvent, Logger, MismatchDiff, ShadowMismatchDetails, ShadowMismatchDiffDetails,
    ShadowMismatchValueDetails,
};
use std::sync::Mutex;

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

#[test]
fn default_warning_includes_only_available_bounded_fields() {
    log::set_logger(&CAPTURE).unwrap();
    log::set_max_level(log::LevelFilter::Warn);
    let warning = |diff, values, logging_outcome| {
        LogEvent::ShadowMismatch(ShadowMismatchDetails {
            namespace: "app".into(),
            use_case: "lookup".into(),
            key_type: "thing".into(),
            cached_value_age_seconds: 30.5,
            cache_key: "one".into(),
            diff,
            values,
            logging_outcome,
        })
    };
    let values = |cached: Option<&str>, source: Option<&str>| {
        Some(ShadowMismatchValueDetails {
            cached_value_json: cached.map(str::to_owned),
            source_value_json: source.map(str::to_owned),
        })
    };
    for event in [
        warning(None, values(Some("\"old\""), Some("\"new\"")), None),
        warning(None, values(None, Some("null")), None),
        warning(
            None,
            values(None, None),
            Some(ShadowMismatchLoggingOutcome::RenderError),
        ),
        warning(
            Some(ShadowMismatchDiffDetails {
                level: MismatchDiff::Values,
                mismatch_paths: Some(vec!["/a\nb".to_owned(), "/c".to_owned()]),
                mismatch_path_count: Some(70),
                diff_json: Some(r#"[{"path":"/c","cached":1}]"#.to_owned()),
            }),
            None,
            None,
        ),
        warning(
            Some(ShadowMismatchDiffDetails {
                level: MismatchDiff::Paths,
                mismatch_paths: None,
                mismatch_path_count: None,
                diff_json: None,
            }),
            values(Some("1"), Some("2")),
            Some(ShadowMismatchLoggingOutcome::HookError),
        ),
    ] {
        LogFacadeLogger.log(&event);
    }
    let messages = CAPTURE.0.lock().unwrap();
    assert_eq!(
        messages[0],
        "DialCache shadow validation mismatch: namespace=app useCase=lookup keyType=thing \
         cachedValueAgeSeconds=30.5 cacheKey=one cachedValue=\"old\" sourceValue=\"new\""
    );
    assert!(!messages[1].contains("cachedValue="));
    assert!(messages[1].contains("sourceValue=null"));
    assert!(!messages[1].contains("loggingOutcome"));
    assert!(!messages[2].contains("cachedValue="));
    assert!(!messages[2].contains("sourceValue="));
    assert!(messages[2].ends_with(" loggingOutcome=render_error"));
    // Paths are a JSON array, so a control character in a member name stays escaped.
    assert!(messages[3].ends_with(
        r#" cacheKey=one mismatchPaths=["/a\nb","/c"] mismatchPathCount=70 diffJson=[{"path":"/c","cached":1}]"#
    ));
    assert!(!messages[4].contains("mismatchPaths="));
    assert!(messages[4].ends_with(" cachedValue=1 sourceValue=2 loggingOutcome=hook_error"));
}
