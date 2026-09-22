//! Exercise the actual default log facade, including optional value previews.
use dialcache::observe::LogFacadeLogger;
use dialcache::{LogEvent, Logger, ShadowMismatchDetails};
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
fn default_warning_includes_only_available_bounded_previews() {
    log::set_logger(&CAPTURE).unwrap();
    log::set_max_level(log::LevelFilter::Warn);
    for (cached, source) in [
        (Some("\"old\""), Some("\"new\"")),
        (None, Some("null")),
        (None, None),
    ] {
        LogFacadeLogger.log(&LogEvent::ShadowMismatch(ShadowMismatchDetails {
            namespace: "app".into(),
            use_case: "lookup".into(),
            key_type: "thing".into(),
            cache_key: "one".into(),
            cached_value_json: cached.map(str::to_owned),
            source_value_json: source.map(str::to_owned),
        }));
    }
    let messages = CAPTURE.0.lock().unwrap();
    assert!(messages[0].contains("cachedValue=\"old\" sourceValue=\"new\""));
    assert!(!messages[1].contains("cachedValue="));
    assert!(messages[1].contains("sourceValue=null"));
    assert!(!messages[2].contains("cachedValue="));
    assert!(!messages[2].contains("sourceValue="));
}
