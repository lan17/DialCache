//! Content of the confirmed-mismatch warning: the requested fields, each
//! failed closed, and the failure that explains them.

use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Serialize;

use crate::local::StoredValue;
use crate::observe::{
    ShadowMismatchDiffDetails, ShadowMismatchLoggingOutcome, ShadowMismatchValueDetails,
};
use crate::operation::{ErasedMismatchDiff, ErasedPreview, MismatchEntry};
use crate::policy::MismatchDiff;
use crate::preview::{
    clamp_utf8, preview_value, JsonPrefix, SHADOW_LOG_DIFF_MAX_BYTES, SHADOW_MISMATCH_MAX_ENTRIES,
};
use crate::protocol::{bound_entry, diff_rendered, MismatchJsonDiff};

/// The effective content leaves of one confirmed-mismatch warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LogPlan {
    pub value: bool,
    pub diff: MismatchDiff,
}

/// One value's native JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Rendering {
    /// The value is absent: only the test-only marker, as Rust's default
    /// codec stores no distinct absent value.
    Absent,
    Json(String),
    /// Serialization failed or panicked.
    Failed,
}

/// The JSON rendering of an operation's values, captured where
/// `T: Serialize` is known.
#[derive(Clone, Copy)]
pub(crate) struct JsonRender {
    render: fn(&StoredValue, bool) -> Rendering,
}

impl JsonRender {
    pub(crate) fn of<T: Serialize + Send + Sync + 'static>() -> Self {
        JsonRender {
            render: render_json::<T>,
        }
    }

    /// The complete rendering.
    fn full(self, value: &StoredValue) -> Rendering {
        (self.render)(value, false)
    }

    /// The value field's prefix, streamed so value-only logging never holds
    /// more than its cap; it checks the whole serialization all the same.
    fn prefix(self, value: &StoredValue) -> Rendering {
        (self.render)(value, true)
    }
}

fn render_json<T: Serialize + 'static>(value: &StoredValue, prefix: bool) -> Rendering {
    let Some(value) = value.downcast_ref::<T>() else {
        return Rendering::Failed;
    };
    catch_unwind(AssertUnwindSafe(|| {
        if prefix {
            let mut json = JsonPrefix::new();
            match write_json(&mut json, value) {
                Ok(true) => Rendering::Absent,
                Ok(false) => Rendering::Json(json.finish()),
                Err(_) => Rendering::Failed,
            }
        } else {
            let mut json = Vec::with_capacity(128);
            match write_json(&mut json, value) {
                Ok(true) => Rendering::Absent,
                Ok(false) => String::from_utf8(json).map_or(Rendering::Failed, Rendering::Json),
                Err(_) => Rendering::Failed,
            }
        }
    }))
    .unwrap_or(Rendering::Failed)
}

/// Serializes `value` as compact JSON; `Ok(true)`, with nothing written, when
/// the value is the absent marker.
#[cfg(not(feature = "test-util"))]
fn write_json<T: Serialize, W: std::io::Write>(writer: W, value: &T) -> serde_json::Result<bool> {
    value.serialize(&mut serde_json::Serializer::new(writer))?;
    Ok(false)
}

/// Serializes `value` as compact JSON; `Ok(true)`, with nothing written, when
/// the value is the absent marker.
#[cfg(feature = "test-util")]
fn write_json<T: Serialize, W: std::io::Write>(writer: W, value: &T) -> serde_json::Result<bool> {
    let mut absent = false;
    value.serialize(absent::TopLevel {
        json: &mut serde_json::Serializer::new(writer),
        absent: &mut absent,
    })?;
    Ok(absent)
}

/// Recognizes [`crate::testing::Absent`] at the top level of a value while
/// rendering it once: every call goes to the JSON serializer except a unit
/// struct carrying the marker's name. Nested markers render as `null`.
#[cfg(feature = "test-util")]
mod absent {
    use serde::ser::{Serialize, Serializer};

    type Json<'a, W> = &'a mut serde_json::Serializer<W>;
    type Result<T> = std::result::Result<T, serde_json::Error>;

    pub(super) struct TopLevel<'a, W> {
        pub json: Json<'a, W>,
        pub absent: &'a mut bool,
    }

    macro_rules! forward {
        ($($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty;)*) => {
            $(fn $name(self, $($arg: $ty),*) -> Result<$ret> { self.json.$name($($arg),*) })*
        };
    }

    impl<'a, W: std::io::Write> Serializer for TopLevel<'a, W> {
        type Ok = ();
        type Error = serde_json::Error;
        type SerializeSeq = <Json<'a, W> as Serializer>::SerializeSeq;
        type SerializeTuple = <Json<'a, W> as Serializer>::SerializeTuple;
        type SerializeTupleStruct = <Json<'a, W> as Serializer>::SerializeTupleStruct;
        type SerializeTupleVariant = <Json<'a, W> as Serializer>::SerializeTupleVariant;
        type SerializeMap = <Json<'a, W> as Serializer>::SerializeMap;
        type SerializeStruct = <Json<'a, W> as Serializer>::SerializeStruct;
        type SerializeStructVariant = <Json<'a, W> as Serializer>::SerializeStructVariant;

        forward! {
            serialize_bool(v: bool) -> ();
            serialize_i8(v: i8) -> ();
            serialize_i16(v: i16) -> ();
            serialize_i32(v: i32) -> ();
            serialize_i64(v: i64) -> ();
            serialize_i128(v: i128) -> ();
            serialize_u8(v: u8) -> ();
            serialize_u16(v: u16) -> ();
            serialize_u32(v: u32) -> ();
            serialize_u64(v: u64) -> ();
            serialize_u128(v: u128) -> ();
            serialize_f32(v: f32) -> ();
            serialize_f64(v: f64) -> ();
            serialize_char(v: char) -> ();
            serialize_str(v: &str) -> ();
            serialize_bytes(v: &[u8]) -> ();
            serialize_none() -> ();
            serialize_unit() -> ();
            serialize_unit_variant(name: &'static str, index: u32, variant: &'static str) -> ();
            serialize_seq(len: Option<usize>) -> Self::SerializeSeq;
            serialize_tuple(len: usize) -> Self::SerializeTuple;
            serialize_tuple_struct(name: &'static str, len: usize) -> Self::SerializeTupleStruct;
            serialize_tuple_variant(name: &'static str, index: u32, variant: &'static str, len: usize) -> Self::SerializeTupleVariant;
            serialize_map(len: Option<usize>) -> Self::SerializeMap;
            serialize_struct(name: &'static str, len: usize) -> Self::SerializeStruct;
            serialize_struct_variant(name: &'static str, index: u32, variant: &'static str, len: usize) -> Self::SerializeStructVariant;
        }

        fn serialize_unit_struct(self, name: &'static str) -> Result<()> {
            if name == crate::testing::ABSENT_MARKER {
                *self.absent = true;
                return Ok(());
            }
            self.json.serialize_unit_struct(name)
        }

        fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<()> {
            self.json.serialize_some(value)
        }

        fn serialize_newtype_struct<T: ?Sized + Serialize>(
            self,
            name: &'static str,
            value: &T,
        ) -> Result<()> {
            self.json.serialize_newtype_struct(name, value)
        }

        fn serialize_newtype_variant<T: ?Sized + Serialize>(
            self,
            name: &'static str,
            index: u32,
            variant: &'static str,
            value: &T,
        ) -> Result<()> {
            self.json
                .serialize_newtype_variant(name, index, variant, value)
        }
    }
}

/// What builds the fields: the operation's JSON rendering, present only
/// while it keeps its default preview, a preview set in its place, and its
/// difference hook.
#[derive(Clone, Default)]
pub(crate) struct Renderers {
    pub json: Option<JsonRender>,
    pub preview: Option<ErasedPreview>,
    pub hook: Option<ErasedMismatchDiff>,
}

impl Renderers {
    /// The JSON rendering the warning derives from. A preview replaces it for
    /// the whole warning, so the built-in walk never reads what the value
    /// fields do not log, and difference fields then need the hook.
    fn rendering(&self) -> Option<JsonRender> {
        self.json.filter(|_| self.preview.is_none())
    }

    /// Whether building the plan's fields calls any renderer or hook, and so
    /// belongs on the bounded CPU executor.
    pub(crate) fn runs_code(&self, plan: LogPlan) -> bool {
        let json = self.rendering().is_some();
        let value = plan.value && (self.preview.is_some() || json);
        let diff = plan.diff != MismatchDiff::Off && (self.hook.is_some() || json);
        value || diff
    }
}

/// The bounded content fields of one warning and the failure explaining any
/// unavailable one.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MismatchContent {
    pub diff: Option<ShadowMismatchDiffDetails>,
    pub values: Option<ShadowMismatchValueDetails>,
    pub failure: Option<ShadowMismatchLoggingOutcome>,
}

impl MismatchContent {
    /// The metadata-only warning after construction itself failed.
    pub(crate) fn failed() -> Self {
        MismatchContent {
            diff: None,
            values: None,
            failure: Some(ShadowMismatchLoggingOutcome::RenderError),
        }
    }
}

/// Builds the content fields the plan requests for one confirmed mismatch.
///
/// Each side is rendered to JSON at most once, and every built-in field
/// derives from that rendering. Every failure fails its fields closed; a
/// failed hook never falls back to the built-in computation. An absent side
/// is not a failure: its value field is unavailable, and the built-in
/// reports the other side whole at the root. The hook replaces the walk, so
/// with `value` off and a hook neither side is rendered. A preview replaces
/// the JSON rendering, so with a preview the difference fields come only
/// from the hook.
pub(crate) fn render_mismatch_log(
    plan: LogPlan,
    cached: &StoredValue,
    source: &StoredValue,
    renderers: &Renderers,
) -> MismatchContent {
    let json = renderers.rendering();
    let walk = plan.diff != MismatchDiff::Off && renderers.hook.is_none();
    let rendering = |value: &StoredValue| -> Option<Rendering> {
        let json = json?;
        if walk {
            Some(json.full(value))
        } else if plan.value {
            Some(json.prefix(value))
        } else {
            None
        }
    };
    let (cached_json, source_json) = (rendering(cached), rendering(source));
    let mut render_failed = false;
    let mut diff_failed = false;

    let values = plan.value.then(|| {
        let mut field = |value: &StoredValue, json: &Option<Rendering>| {
            let text = match (&renderers.preview, json) {
                (_, Some(Rendering::Absent)) => return None,
                (Some(preview), _) => match catch_unwind(AssertUnwindSafe(|| preview(value))) {
                    Ok(Some(text)) => Some(text),
                    _ => None,
                },
                (None, Some(Rendering::Json(json))) => Some(json.clone()),
                (None, _) => None,
            };
            render_failed |= text.is_none();
            text.map(|text| preview_value(&text))
        };
        ShadowMismatchValueDetails {
            cached_value_json: field(cached, &cached_json),
            source_value_json: field(source, &source_json),
        }
    });

    let diff = (plan.diff != MismatchDiff::Off).then(|| {
        let with_values = plan.diff == MismatchDiff::Values;
        let computed = if let Some(hook) = &renderers.hook {
            let entries = run_hook(hook, cached, source, with_values);
            diff_failed = entries.is_none();
            entries
        } else {
            match (rendered_side(&cached_json), rendered_side(&source_json)) {
                (Some(cached), Some(source)) => {
                    // A rendering too deep for the parser fails here, as a walk failure.
                    match catch_unwind(AssertUnwindSafe(|| {
                        diff_rendered(cached, source, with_values)
                    })) {
                        Ok(Ok(diff)) => Some(diff),
                        _ => {
                            diff_failed = true;
                            None
                        }
                    }
                }
                // A side without a rendering, or a warning without JSON: an
                // operation built with a codec (lan17/DialCache#245 tracks a
                // renderer for those), or one whose preview replaces its JSON
                // or was set to `None`.
                _ => {
                    render_failed = true;
                    None
                }
            }
        };
        match computed {
            None => ShadowMismatchDiffDetails {
                level: plan.diff,
                mismatch_paths: None,
                mismatch_path_count: None,
                diff_json: None,
            },
            Some(diff) => {
                let diff_json = with_values.then(|| render_diff_json(&diff.entries));
                render_failed |= diff_json == Some(None);
                ShadowMismatchDiffDetails {
                    level: plan.diff,
                    mismatch_paths: Some(
                        diff.entries.into_iter().map(|entry| entry.path).collect(),
                    ),
                    mismatch_path_count: Some(diff.count),
                    diff_json: diff_json.flatten(),
                }
            }
        }
    });

    MismatchContent {
        diff,
        values,
        failure: if diff_failed {
            Some(ShadowMismatchLoggingOutcome::HookError)
        } else if render_failed {
            Some(ShadowMismatchLoggingOutcome::RenderError)
        } else {
            None
        },
    }
}

/// A side the walk can compare: `Some(None)` when absent, `None` when it has
/// no rendering.
fn rendered_side(json: &Option<Rendering>) -> Option<Option<&str>> {
    match json {
        Some(Rendering::Json(text)) => Some(Some(text.as_str())),
        Some(Rendering::Absent) => Some(None),
        Some(Rendering::Failed) | None => None,
    }
}

/// Runs the hook under the comparator's discipline and bounds its entries;
/// `None` when it panicked.
fn run_hook(
    hook: &ErasedMismatchDiff,
    cached: &StoredValue,
    source: &StoredValue,
    with_values: bool,
) -> Option<MismatchJsonDiff> {
    let entries = catch_unwind(AssertUnwindSafe(|| hook(cached, source))).ok()??;
    Some(MismatchJsonDiff {
        count: entries.len() as u64,
        entries: entries
            .iter()
            .take(SHADOW_MISMATCH_MAX_ENTRIES)
            .map(|entry| {
                bound_entry(
                    &entry.path,
                    entry.cached.as_ref(),
                    entry.source.as_ref(),
                    with_values,
                )
            })
            .collect(),
    })
}

/// The bounded entries as one JSON array, clamped to the field's cap. Entry
/// sides are JSON values, so the rendering cannot fail.
fn render_diff_json(entries: &[MismatchEntry]) -> Option<String> {
    serde_json::to_string(entries)
        .ok()
        .map(|json| clamp_utf8(&json, SHADOW_LOG_DIFF_MAX_BYTES))
}
