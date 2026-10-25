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
    clamp_utf8, json_preview, preview_value, SHADOW_LOG_DIFF_MAX_BYTES, SHADOW_MISMATCH_MAX_ENTRIES,
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
        if is_absent(value) {
            return Rendering::Absent;
        }
        let json = if prefix {
            json_preview(value)
        } else {
            serde_json::to_string(value).ok()
        };
        json.map_or(Rendering::Failed, Rendering::Json)
    }))
    .unwrap_or(Rendering::Failed)
}

#[cfg(not(feature = "test-util"))]
fn is_absent<T: Serialize>(_: &T) -> bool {
    false
}

#[cfg(feature = "test-util")]
fn is_absent<T: Serialize>(value: &T) -> bool {
    value.serialize(absent::Probe).is_ok()
}

/// Recognizes [`crate::testing::Absent`] at the top level of a value: every
/// serializer call fails except a unit struct carrying the marker's name, so
/// the probe stops at the value's first call.
#[cfg(feature = "test-util")]
mod absent {
    use serde::ser::{Impossible, Serializer};

    #[derive(Debug)]
    pub(super) struct Present;

    impl std::fmt::Display for Present {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("not the absent marker")
        }
    }

    impl std::error::Error for Present {}

    impl serde::ser::Error for Present {
        fn custom<T: std::fmt::Display>(_: T) -> Self {
            Present
        }
    }

    pub(super) struct Probe;

    macro_rules! present {
        ($($name:ident($($arg:ty),*);)*) => {
            $(fn $name(self, $(_: $arg),*) -> Result<(), Present> { Err(Present) })*
        };
    }

    impl Serializer for Probe {
        type Ok = ();
        type Error = Present;
        type SerializeSeq = Impossible<(), Present>;
        type SerializeTuple = Impossible<(), Present>;
        type SerializeTupleStruct = Impossible<(), Present>;
        type SerializeTupleVariant = Impossible<(), Present>;
        type SerializeMap = Impossible<(), Present>;
        type SerializeStruct = Impossible<(), Present>;
        type SerializeStructVariant = Impossible<(), Present>;

        present! {
            serialize_bool(bool);
            serialize_i8(i8);
            serialize_i16(i16);
            serialize_i32(i32);
            serialize_i64(i64);
            serialize_u8(u8);
            serialize_u16(u16);
            serialize_u32(u32);
            serialize_u64(u64);
            serialize_f32(f32);
            serialize_f64(f64);
            serialize_char(char);
            serialize_str(&str);
            serialize_bytes(&[u8]);
            serialize_none();
            serialize_unit();
            serialize_unit_variant(&'static str, u32, &'static str);
        }

        fn serialize_unit_struct(self, name: &'static str) -> Result<(), Present> {
            if name == crate::testing::ABSENT_MARKER {
                Ok(())
            } else {
                Err(Present)
            }
        }

        fn serialize_some<T: ?Sized + serde::Serialize>(self, _: &T) -> Result<(), Present> {
            Err(Present)
        }

        fn serialize_newtype_struct<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            _: &T,
        ) -> Result<(), Present> {
            Err(Present)
        }

        fn serialize_newtype_variant<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: &T,
        ) -> Result<(), Present> {
            Err(Present)
        }

        fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Present> {
            Err(Present)
        }

        fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Present> {
            Err(Present)
        }

        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleStruct, Present> {
            Err(Present)
        }

        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleVariant, Present> {
            Err(Present)
        }

        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Present> {
            Err(Present)
        }

        fn serialize_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStruct, Present> {
            Err(Present)
        }

        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStructVariant, Present> {
            Err(Present)
        }
    }
}

/// What builds the fields: the operation's JSON rendering, its value preview
/// and its difference hook.
#[derive(Clone, Default)]
pub(crate) struct Renderers {
    pub json: Option<JsonRender>,
    pub preview: Option<ErasedPreview>,
    pub hook: Option<ErasedMismatchDiff>,
}

impl Renderers {
    /// Whether building the plan's fields calls any renderer or hook, and so
    /// belongs on the bounded CPU executor.
    pub(crate) fn runs_code(&self, plan: LogPlan) -> bool {
        let value = plan.value && (self.preview.is_some() || self.json.is_some());
        let diff = plan.diff != MismatchDiff::Off && (self.hook.is_some() || self.json.is_some());
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
/// with `value` off and a hook neither side is rendered.
pub(crate) fn render_mismatch_log(
    plan: LogPlan,
    cached: &StoredValue,
    source: &StoredValue,
    renderers: &Renderers,
) -> MismatchContent {
    let walk = plan.diff != MismatchDiff::Off && renderers.hook.is_none();
    let rendering = |value: &StoredValue| -> Option<Rendering> {
        let json = renderers.json?;
        if walk {
            Some(json.full(value))
        } else if plan.value && renderers.preview.is_none() {
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
