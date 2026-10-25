//! Native tests of the built-in mismatch walk and of warning content: the
//! walk vectors, every cap, absent sides, failures and the hook.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::ser::Error as _;
use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::local::StoredValue;
use crate::observe::{
    ShadowMismatchDiffDetails, ShadowMismatchLoggingOutcome, ShadowMismatchValueDetails,
};
use crate::operation::{ErasedMismatchDiff, ErasedPreview, MismatchEntry};
use crate::policy::MismatchDiff;
use crate::preview::{
    SHADOW_LOG_DIFF_MAX_BYTES, SHADOW_LOG_TRUNCATION_MARKER, SHADOW_LOG_VALUE_MAX_BYTES,
};
use crate::protocol::diff_shadow_mismatch_json;
use crate::shadow_log::{render_mismatch_log, JsonRender, LogPlan, MismatchContent, Renderers};

const VALUE_ONLY: LogPlan = LogPlan {
    value: true,
    diff: MismatchDiff::Off,
};
const PATHS_ONLY: LogPlan = LogPlan {
    value: false,
    diff: MismatchDiff::Paths,
};
const VALUES_ONLY: LogPlan = LogPlan {
    value: false,
    diff: MismatchDiff::Values,
};
const EVERYTHING: LogPlan = LogPlan {
    value: true,
    diff: MismatchDiff::Values,
};

impl LogPlan {
    fn with_value(self) -> LogPlan {
        LogPlan {
            value: true,
            ..self
        }
    }
}
const HOOK_ERROR: Option<ShadowMismatchLoggingOutcome> =
    Some(ShadowMismatchLoggingOutcome::HookError);
const RENDER_ERROR: Option<ShadowMismatchLoggingOutcome> =
    Some(ShadowMismatchLoggingOutcome::RenderError);

// Hand-authored expectations for the built-in differ, copied unchanged from
// the TypeScript reference so the group can move into
// formal/catalogs/protocol-vectors.json. The depth vectors nest arrays in
// groups of eight; each "/0" is one token.
const MISMATCH_PATH_VECTORS: &str = r#"[
  {
    "name": "identical objects",
    "cached": {"id": "123", "tags": ["a", "b"], "meta": {}, "list": [], "profile": {"email": "a@example.com"}},
    "source": {"id": "123", "tags": ["a", "b"], "meta": {}, "list": [], "profile": {"email": "a@example.com"}},
    "entries": [],
    "count": 0
  },
  {
    "name": "identical primitives",
    "cached": "same",
    "source": "same",
    "entries": [],
    "count": 0
  },
  {
    "name": "identical objects with different member order",
    "cached": {"a": 1, "b": {"c": 2, "d": 3}},
    "source": {"b": {"d": 3, "c": 2}, "a": 1},
    "entries": [],
    "count": 0
  },
  {
    "name": "differing number roots",
    "cached": 1,
    "source": 2,
    "entries": [{"path": "", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "differing string roots",
    "cached": "old",
    "source": "new",
    "entries": [{"path": "", "cached": "old", "source": "new"}],
    "count": 1
  },
  {
    "name": "null root against false root",
    "cached": null,
    "source": false,
    "entries": [{"path": "", "cached": null, "source": false}],
    "count": 1
  },
  {
    "name": "number root against string root",
    "cached": 1,
    "source": "1",
    "entries": [{"path": "", "cached": 1, "source": "1"}],
    "count": 1
  },
  {
    "name": "object root against array root",
    "cached": {},
    "source": [],
    "entries": [{"path": "", "cached": {}, "source": []}],
    "count": 1
  },
  {
    "name": "array root against string root",
    "cached": ["a"],
    "source": "a",
    "entries": [{"path": "", "cached": ["a"], "source": "a"}],
    "count": 1
  },
  {
    "name": "null root against object root",
    "cached": null,
    "source": {"a": null},
    "entries": [{"path": "", "cached": null, "source": {"a": null}}],
    "count": 1
  },
  {
    "name": "nested member change",
    "cached": {"id": "123", "profile": {"email": "old@example.com", "name": "Ada"}},
    "source": {"id": "123", "profile": {"email": "new@example.com", "name": "Ada"}},
    "entries": [{"path": "/profile/email", "cached": "old@example.com", "source": "new@example.com"}],
    "count": 1
  },
  {
    "name": "nested members changing kind",
    "cached": {"a": [1], "b": {"c": 1}, "d": null},
    "source": {"a": {"0": 1}, "b": "c", "d": {}},
    "entries": [
      {"path": "/a", "cached": [1], "source": {"0": 1}},
      {"path": "/b", "cached": {"c": 1}, "source": "c"},
      {"path": "/d", "cached": null, "source": {}}
    ],
    "count": 3
  },
  {
    "name": "member only in cached",
    "cached": {"id": 1, "legacy": {"flag": true}},
    "source": {"id": 1},
    "entries": [{"path": "/legacy", "cached": {"flag": true}}],
    "count": 1
  },
  {
    "name": "member only in source",
    "cached": {"id": 1},
    "source": {"id": 1, "roles": ["admin"]},
    "entries": [{"path": "/roles", "source": ["admin"]}],
    "count": 1
  },
  {
    "name": "one-sided members on both sides",
    "cached": {"a": 1, "b": 2},
    "source": {"b": 2, "c": 3},
    "entries": [{"path": "/a", "cached": 1}, {"path": "/c", "source": 3}],
    "count": 2
  },
  {
    "name": "one-sided null member",
    "cached": {"a": null},
    "source": {},
    "entries": [{"path": "/a", "cached": null}],
    "count": 1
  },
  {
    "name": "member names in UTF-16 code-unit order",
    "cached": {"～": 1, "b": 1, "😀": 1, "a": 1, "B": 1},
    "source": {"a": 2, "😀": 2, "B": 2, "～": 2, "b": 2},
    "entries": [
      {"path": "/B", "cached": 1, "source": 2},
      {"path": "/a", "cached": 1, "source": 2},
      {"path": "/b", "cached": 1, "source": 2},
      {"path": "/😀", "cached": 1, "source": 2},
      {"path": "/～", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "integer-like member names in string order",
    "cached": {"9": 1, "10": 1, "a": 1},
    "source": {"9": 2, "10": 2, "a": 2},
    "entries": [
      {"path": "/10", "cached": 1, "source": 2},
      {"path": "/9", "cached": 1, "source": 2},
      {"path": "/a", "cached": 1, "source": 2}
    ],
    "count": 3
  },
  {
    "name": "equal-length arrays recursed by index",
    "cached": {"items": [1, 2, 3]},
    "source": {"items": [1, 5, 4]},
    "entries": [
      {"path": "/items/1", "cached": 2, "source": 5},
      {"path": "/items/2", "cached": 3, "source": 4}
    ],
    "count": 2
  },
  {
    "name": "equal-length arrays of objects recursed into each item",
    "cached": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}],
    "source": [{"id": 1, "name": "a"}, {"id": 2, "name": "c"}],
    "entries": [{"path": "/1/name", "cached": "b", "source": "c"}],
    "count": 1
  },
  {
    "name": "different-length root arrays reported once",
    "cached": [1, 2],
    "source": [1, 2, 3],
    "entries": [{"path": "", "cached": [1, 2], "source": [1, 2, 3]}],
    "count": 1
  },
  {
    "name": "different-length nested arrays reported once at the array pointer",
    "cached": {"name": "x", "roles": ["admin"], "tags": []},
    "source": {"name": "y", "roles": ["admin", "owner"], "tags": [null]},
    "entries": [
      {"path": "/name", "cached": "x", "source": "y"},
      {"path": "/roles", "cached": ["admin"], "source": ["admin", "owner"]},
      {"path": "/tags", "cached": [], "source": [null]}
    ],
    "count": 3
  },
  {
    "name": "escaped reference tokens and the empty member name",
    "cached": {"m~n": 1, "a/b": 1, "/": 1, "~1": 1, "": 1},
    "source": {"": 2, "~1": 2, "/": 2, "a/b": 2, "m~n": 2},
    "entries": [
      {"path": "/", "cached": 1, "source": 2},
      {"path": "/~1", "cached": 1, "source": 2},
      {"path": "/a~1b", "cached": 1, "source": 2},
      {"path": "/m~0n", "cached": 1, "source": 2},
      {"path": "/~01", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "nested empty member names",
    "cached": {"": {"": "x"}},
    "source": {"": {"": "y"}},
    "entries": [{"path": "//", "cached": "x", "source": "y"}],
    "count": 1
  },
  {
    "name": "escaped tokens composed with array indices",
    "cached": {"a/b": [0, {"~": 1}]},
    "source": {"a/b": [0, {"~": 2}]},
    "entries": [{"path": "/a~1b/1/~0", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "entries in walk order",
    "cached": {"z": [1, {"b": 1, "a": 1}], "a": {"y": 1, "x": 1}},
    "source": {"a": {"x": 2, "y": 2}, "z": [2, {"a": 2, "b": 2}]},
    "entries": [
      {"path": "/a/x", "cached": 1, "source": 2},
      {"path": "/a/y", "cached": 1, "source": 2},
      {"path": "/z/0", "cached": 1, "source": 2},
      {"path": "/z/1/a", "cached": 1, "source": 2},
      {"path": "/z/1/b", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "difference at the depth cap reported at its own pointer",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ 1 ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ 2 ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [{"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "difference past the depth cap reported at the 32-token container",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ [1] ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ [2] ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [{"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0", "cached": [1], "source": [2]}],
    "count": 1
  },
  {
    "name": "equal containers past the depth cap with different member order",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ {"a": 1, "b": {"c": [1, 2], "d": null}} ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ {"b": {"d": null, "c": [1, 2]}, "a": 1} ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [],
    "count": 0
  },
  {
    "name": "containers at the depth cap reported whole",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[ {
      "kinds": {"m": [1]},
      "kindsSwap": {"m": {"0": 1}},
      "lengths": [[1, 2]],
      "lengthsShort": [[1]],
      "members": {"k": 1},
      "order": {"x": 1, "y": {"p": null, "q": [true]}},
      "sizes": {"a": 1},
      "values": [1]
    } ]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[ {
      "values": [2],
      "sizes": {"a": 1, "b": 2},
      "order": {"y": {"q": [true], "p": null}, "x": 1},
      "members": {"j": 1},
      "lengthsShort": [[1, 2]],
      "lengths": [[1]],
      "kindsSwap": {"m": [1]},
      "kinds": {"m": {"0": 1}}
    } ]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/kinds", "cached": {"m": [1]}, "source": {"m": {"0": 1}}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/kindsSwap", "cached": {"m": {"0": 1}}, "source": {"m": [1]}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/lengths", "cached": [[1, 2]], "source": [[1]]},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/lengthsShort", "cached": [[1]], "source": [[1, 2]]},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/members", "cached": {"k": 1}, "source": {"j": 1}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/sizes", "cached": {"a": 1}, "source": {"a": 1, "b": 2}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/values", "cached": [1], "source": [2]}
    ],
    "count": 7
  },
  {
    "name": "documented example: a user record at four differing fields",
    "cached": {"id": "u_123", "email": "ana@example.com", "plan": "free", "roles": ["viewer"], "profile": {"name": "Ana", "locale": "en-US"}},
    "source": {"id": "u_123", "email": "ana@example.com", "plan": "pro", "roles": ["viewer", "editor"], "profile": {"name": "Ana", "locale": "en-GB", "timezone": "Europe/London"}},
    "entries": [
      {"path": "/plan", "cached": "free", "source": "pro"},
      {"path": "/profile/locale", "cached": "en-US", "source": "en-GB"},
      {"path": "/profile/timezone", "source": "Europe/London"},
      {"path": "/roles", "cached": ["viewer"], "source": ["viewer", "editor"]}
    ],
    "count": 4
  },
  {
    "name": "documented example: a changed field",
    "cached": {"plan": "free"},
    "source": {"plan": "pro"},
    "entries": [{"path": "/plan", "cached": "free", "source": "pro"}],
    "count": 1
  },
  {
    "name": "documented example: an element changed in place",
    "cached": {"tags": ["a", "b"]},
    "source": {"tags": ["a", "c"]},
    "entries": [{"path": "/tags/1", "cached": "b", "source": "c"}],
    "count": 1
  },
  {
    "name": "documented example: an element inserted",
    "cached": {"tags": ["a", "b"]},
    "source": {"tags": ["a", "x", "b"]},
    "entries": [{"path": "/tags", "cached": ["a", "b"], "source": ["a", "x", "b"]}],
    "count": 1
  },
  {
    "name": "documented example: a field only the source has",
    "cached": {"name": "Ana"},
    "source": {"name": "Ana", "nickname": "A"},
    "entries": [{"path": "/nickname", "source": "A"}],
    "count": 1
  },
  {
    "name": "documented example: a field only the cache has",
    "cached": {"name": "Ana", "nickname": "A"},
    "source": {"name": "Ana"},
    "entries": [{"path": "/nickname", "cached": "A"}],
    "count": 1
  },
  {
    "name": "documented example: a field changing type",
    "cached": {"count": 1},
    "source": {"count": "1"},
    "entries": [{"path": "/count", "cached": 1, "source": "1"}],
    "count": 1
  },
  {
    "name": "documented example: an object replaced by null",
    "cached": {"address": {"city": "Paris"}},
    "source": {"address": null},
    "entries": [{"path": "/address", "cached": {"city": "Paris"}, "source": null}],
    "count": 1
  },
  {
    "name": "documented example: member names with escaped characters",
    "cached": {"a/b": 1, "m~n": 1},
    "source": {"a/b": 2, "m~n": 2},
    "entries": [
      {"path": "/a~1b", "cached": 1, "source": 2},
      {"path": "/m~0n", "cached": 1, "source": 2}
    ],
    "count": 2
  },
  {
    "name": "documented example: roots of different kinds",
    "cached": ["a", "b"],
    "source": {"items": ["a", "b"]},
    "entries": [{"path": "", "cached": ["a", "b"], "source": {"items": ["a", "b"]}}],
    "count": 1
  }
]"#;

const CACHED_USER_JSON: &str = r#"{"id":"123","email":"old@example.com"}"#;
const SOURCE_USER_JSON: &str = r#"{"id":"123","email":"new@example.com"}"#;

/// A compared value: JSON, a record serialized in field order, the test-only
/// absent marker, a value whose serialization fails or panics, or JSON that
/// counts its serializations.
#[derive(Clone)]
enum V {
    Json(Value),
    User(User),
    Absent,
    Fails,
    Panics,
    Counted(Value, Arc<AtomicUsize>),
}

#[derive(Clone, Serialize)]
struct User {
    id: &'static str,
    email: &'static str,
}

impl Serialize for V {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            V::Json(value) => value.serialize(serializer),
            V::User(user) => user.serialize(serializer),
            V::Absent => crate::testing::Absent.serialize(serializer),
            V::Fails => Err(S::Error::custom("not serializable")),
            V::Panics => panic!("serialization panicked"),
            V::Counted(value, renders) => {
                renders.fetch_add(1, Ordering::SeqCst);
                value.serialize(serializer)
            }
        }
    }
}

fn cached_user() -> V {
    V::User(User {
        id: "123",
        email: "old@example.com",
    })
}

fn source_user() -> V {
    V::User(User {
        id: "123",
        email: "new@example.com",
    })
}

fn stored(value: V) -> StoredValue {
    Arc::new(value)
}

fn json_renderers() -> Renderers {
    Renderers {
        json: Some(JsonRender::of::<V>()),
        ..Renderers::default()
    }
}

fn with_hook(hook: impl Fn(&V, &V) -> Vec<MismatchEntry> + Send + Sync + 'static) -> Renderers {
    let hook: ErasedMismatchDiff = Arc::new(move |cached: &StoredValue, source: &StoredValue| {
        Some(hook(cached.downcast_ref()?, source.downcast_ref()?))
    });
    Renderers {
        hook: Some(hook),
        ..json_renderers()
    }
}

fn render(plan: LogPlan, cached: V, source: V) -> MismatchContent {
    render_with(plan, cached, source, &json_renderers())
}

fn render_with(plan: LogPlan, cached: V, source: V, renderers: &Renderers) -> MismatchContent {
    render_mismatch_log(plan, &stored(cached), &stored(source), renderers)
}

fn diff_fields(
    level: MismatchDiff,
    paths: Option<&[&str]>,
    count: Option<u64>,
    diff_json: Option<&str>,
) -> Option<ShadowMismatchDiffDetails> {
    Some(ShadowMismatchDiffDetails {
        level,
        mismatch_paths: paths.map(|paths| paths.iter().map(|path| path.to_string()).collect()),
        mismatch_path_count: count,
        diff_json: diff_json.map(str::to_owned),
    })
}

fn values(cached: Option<&str>, source: Option<&str>) -> Option<ShadowMismatchValueDetails> {
    Some(ShadowMismatchValueDetails {
        cached_value_json: cached.map(str::to_owned),
        source_value_json: source.map(str::to_owned),
    })
}

fn content(
    diff: Option<ShadowMismatchDiffDetails>,
    values: Option<ShadowMismatchValueDetails>,
    failure: Option<ShadowMismatchLoggingOutcome>,
) -> MismatchContent {
    MismatchContent {
        diff,
        values,
        failure,
    }
}

/// The diff fields after the hook or the walk failed, at `plan`'s level.
fn failed_diff(plan: LogPlan) -> Option<ShadowMismatchDiffDetails> {
    diff_fields(plan.diff, None, None, None)
}

fn entries_json(diff: &crate::protocol::MismatchJsonDiff) -> Value {
    serde_json::to_value(&diff.entries).unwrap()
}

fn nest_members(depth: usize, leaf: Value) -> Value {
    (0..depth).fold(leaf, |value, _| json!({ "n": value }))
}

fn vectors() -> Vec<Value> {
    serde_json::from_str(MISMATCH_PATH_VECTORS).unwrap()
}

#[test]
fn built_in_walk_computes_every_vector() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 40);
    for vector in vectors {
        let diff = diff_shadow_mismatch_json(&vector["cached"], &vector["source"]);
        assert_eq!(entries_json(&diff), vector["entries"], "{}", vector["name"]);
        assert_eq!(
            Some(diff.count),
            vector["count"].as_u64(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn every_vector_renders_its_diff_fields_at_each_level() {
    for vector in vectors() {
        let name = &vector["name"];
        let (cached, source) = (
            V::Json(vector["cached"].clone()),
            V::Json(vector["source"].clone()),
        );
        let paths: Vec<&str> = vector["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        let count = vector["count"].as_u64();
        let rendered = render(VALUES_ONLY, cached.clone(), source.clone());
        assert_eq!(rendered.failure, None, "{name}");
        let fields = rendered.diff.unwrap();
        assert_eq!(
            fields.mismatch_paths.as_deref(),
            Some(&paths.iter().map(|p| p.to_string()).collect::<Vec<_>>()[..]),
            "{name}"
        );
        assert_eq!(fields.mismatch_path_count, count, "{name}");
        let logged: Value = serde_json::from_str(fields.diff_json.as_deref().unwrap()).unwrap();
        assert_eq!(logged, vector["entries"], "{name}");
        assert_eq!(
            render(PATHS_ONLY, cached, source),
            content(
                diff_fields(MismatchDiff::Paths, Some(&paths), count, None),
                None,
                None
            ),
            "{name}"
        );
    }
}

#[test]
fn walk_reads_members_named_like_object_intrinsics_as_ordinary_members() {
    let cached: Value = serde_json::from_str(r#"{"constructor":1,"__proto__":{"a":1}}"#).unwrap();
    let source: Value =
        serde_json::from_str(r#"{"toString":"x","valueOf":null,"__proto__":{"a":2}}"#).unwrap();
    let entries = json!([
        {"path": "/__proto__/a", "cached": 1, "source": 2},
        {"path": "/constructor", "cached": 1},
        {"path": "/toString", "source": "x"},
        {"path": "/valueOf", "source": null},
    ]);
    let diff = diff_shadow_mismatch_json(&cached, &source);
    assert_eq!((entries_json(&diff), diff.count), (entries.clone(), 4));
    let fields = render(VALUES_ONLY, V::Json(cached), V::Json(source))
        .diff
        .unwrap();
    let logged: Value = serde_json::from_str(fields.diff_json.as_deref().unwrap()).unwrap();
    assert_eq!(logged, entries);
}

#[test]
fn a_depth_capped_pair_compares_only_its_own_members() {
    let nest = |leaf: &str| -> Value {
        serde_json::from_str(&format!(
            "{}{leaf}{}",
            r#"{"a":"#.repeat(32),
            "}".repeat(32)
        ))
        .unwrap()
    };
    let diff = diff_shadow_mismatch_json(&nest(r#"{"__proto__":{}}"#), &nest(r#"{"b":{}}"#));
    assert_eq!(
        (entries_json(&diff), diff.count),
        (
            json!([{"path": "/a".repeat(32), "cached": {"__proto__": {}}, "source": {"b": {}}}]),
            1
        )
    );
}

#[test]
fn the_walk_cuts_entries_at_64_in_walk_order_and_counts_every_difference() {
    let (mut cached, mut source) = (serde_json::Map::new(), serde_json::Map::new());
    for index in (0..70).rev() {
        cached.insert(format!("m{index:02}"), json!(0));
        source.insert(format!("m{index:02}"), json!(1));
    }
    let entries: Vec<Value> = (0..64)
        .map(|index| json!({"path": format!("/m{index:02}"), "cached": 0, "source": 1}))
        .collect();
    let (cached, source) = (Value::Object(cached), Value::Object(source));
    let diff = diff_shadow_mismatch_json(&cached, &source);
    assert_eq!(
        (entries_json(&diff), diff.count),
        (Value::Array(entries.clone()), 70)
    );
    let paths: Vec<&str> = entries
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        render(PATHS_ONLY, V::Json(cached), V::Json(source)),
        content(
            diff_fields(MismatchDiff::Paths, Some(&paths), Some(70), None),
            None,
            None
        )
    );
}

#[test]
fn each_pointer_is_clamped_to_512_bytes_on_a_character_boundary() {
    let names = ["k".repeat(511), "k".repeat(600), "é".repeat(300)];
    let cached = Value::Object(names.iter().map(|name| (name.clone(), json!(1))).collect());
    let source = Value::Object(names.iter().map(|name| (name.clone(), json!(2))).collect());
    let diff = diff_shadow_mismatch_json(&cached, &source);
    assert_eq!(
        (entries_json(&diff), diff.count),
        (
            json!([
                {"path": format!("/{}", "k".repeat(511)), "cached": 1, "source": 2},
                {"path": format!("/{}{SHADOW_LOG_TRUNCATION_MARKER}", "k".repeat(497)), "cached": 1, "source": 2},
                {"path": format!("/{}{SHADOW_LOG_TRUNCATION_MARKER}", "é".repeat(248)), "cached": 1, "source": 2},
            ]),
            3
        )
    );
}

#[test]
fn each_side_over_1_kib_becomes_its_clamped_json_text() {
    let list = vec![1000; 300];
    let cached = json!({
        "accent": "é".repeat(600),
        "blob": "x".repeat(2000),
        "edge": "e".repeat(1022),
        "extra": "z".repeat(1100),
        "list": list,
    });
    let source = json!({"accent": "a", "blob": "y", "edge": "f".repeat(1022), "list": [1000]});
    let list_json = serde_json::to_string(&list).unwrap();
    let diff = diff_shadow_mismatch_json(&cached, &source);
    assert_eq!(
        (entries_json(&diff), diff.count),
        (
            json!([
                {"path": "/accent", "cached": format!("\"{}{SHADOW_LOG_TRUNCATION_MARKER}", "é".repeat(504)), "source": "a"},
                {"path": "/blob", "cached": format!("\"{}{SHADOW_LOG_TRUNCATION_MARKER}", "x".repeat(1009)), "source": "y"},
                {"path": "/edge", "cached": "e".repeat(1022), "source": "f".repeat(1022)},
                {"path": "/extra", "cached": format!("\"{}{SHADOW_LOG_TRUNCATION_MARKER}", "z".repeat(1009))},
                {"path": "/list", "cached": format!("{}{SHADOW_LOG_TRUNCATION_MARKER}", &list_json[..1010]), "source": [1000]},
            ]),
            5
        )
    );
}

#[test]
fn the_walk_stops_at_32_reference_tokens_however_deep_the_difference_lies() {
    let diff = diff_shadow_mismatch_json(&nest_members(40, json!(1)), &nest_members(40, json!(2)));
    assert_eq!(
        (entries_json(&diff), diff.count),
        (
            json!([{"path": "/n".repeat(32), "cached": nest_members(8, json!(1)), "source": nest_members(8, json!(2))}]),
            1
        )
    );
    let clamped = format!("{}{SHADOW_LOG_TRUNCATION_MARKER}", r#"{"n":"#.repeat(202));
    let diff =
        diff_shadow_mismatch_json(&nest_members(1000, json!(1)), &nest_members(1000, json!(2)));
    assert_eq!(
        (entries_json(&diff), diff.count),
        (
            json!([{"path": "/n".repeat(32), "cached": clamped, "source": clamped}]),
            1
        )
    );
}

#[test]
fn equal_containers_past_the_depth_cap_compare_equal_regardless_of_member_order() {
    let (mut cached, mut source) = (json!("leaf"), json!("leaf"));
    for level in 0..1000 {
        cached = json!({"a": level, "next": cached});
        source = json!({"next": source, "a": level});
    }
    let diff = diff_shadow_mismatch_json(&cached, &source);
    assert_eq!((entries_json(&diff), diff.count), (json!([]), 0));
}

#[test]
fn numbers_compare_by_value_as_parsed_json_does() {
    let diff = diff_shadow_mismatch_json(
        &json!({"a": 1, "b": -0.0, "c": 1.5}),
        &json!({"a": 1.0, "b": 0, "c": 1.25}),
    );
    assert_eq!(
        (entries_json(&diff), diff.count),
        (json!([{"path": "/c", "cached": 1.5, "source": 1.25}]), 1)
    );
}

#[test]
fn renders_exactly_the_fields_each_plan_requests() {
    let diff_json = r#"[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]"#;
    let user_values = values(Some(CACHED_USER_JSON), Some(SOURCE_USER_JSON));
    for (plan, expected) in [
        (
            PATHS_ONLY,
            content(
                diff_fields(MismatchDiff::Paths, Some(&["/email"]), Some(1), None),
                None,
                None,
            ),
        ),
        (
            VALUES_ONLY,
            content(
                diff_fields(
                    MismatchDiff::Values,
                    Some(&["/email"]),
                    Some(1),
                    Some(diff_json),
                ),
                None,
                None,
            ),
        ),
        (VALUE_ONLY, content(None, user_values.clone(), None)),
        (
            LogPlan {
                value: true,
                diff: MismatchDiff::Paths,
            },
            content(
                diff_fields(MismatchDiff::Paths, Some(&["/email"]), Some(1), None),
                user_values.clone(),
                None,
            ),
        ),
        (
            EVERYTHING,
            content(
                diff_fields(
                    MismatchDiff::Values,
                    Some(&["/email"]),
                    Some(1),
                    Some(diff_json),
                ),
                user_values.clone(),
                None,
            ),
        ),
    ] {
        assert_eq!(
            render(plan, cached_user(), source_user()),
            expected,
            "{plan:?}"
        );
    }
}

#[test]
fn byte_identical_renderings_have_no_entries() {
    // The comparator saw a difference the JSON does not show.
    assert_eq!(
        render(
            EVERYTHING,
            V::Json(json!({"id": 1})),
            V::Json(json!({"id": 1}))
        ),
        content(
            diff_fields(MismatchDiff::Values, Some(&[]), Some(0), Some("[]")),
            values(Some(r#"{"id":1}"#), Some(r#"{"id":1}"#)),
            None
        )
    );
}

#[test]
fn byte_clamps_value_fields_without_splitting_utf8_sequences() {
    let value = V::Json(json!({"text": "🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES)}));
    let fields = render(VALUE_ONLY, value.clone(), value).values.unwrap();
    let cached = fields.cached_value_json.unwrap();
    assert!(cached.len() <= SHADOW_LOG_VALUE_MAX_BYTES);
    assert!(cached.ends_with(SHADOW_LOG_TRUNCATION_MARKER));
    assert_eq!(fields.source_value_json, Some(cached));
}

#[test]
fn an_absent_root_is_one_side_at_the_root_pointer_not_a_render_failure() {
    assert_eq!(
        render(EVERYTHING, V::Absent, V::Json(json!({"version": 2}))),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&[""]),
                Some(1),
                Some(r#"[{"path":"","source":{"version":2}}]"#)
            ),
            values(None, Some(r#"{"version":2}"#)),
            None
        )
    );
    assert_eq!(
        render(EVERYTHING, V::Json(json!({"version": 2})), V::Absent),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&[""]),
                Some(1),
                Some(r#"[{"path":"","cached":{"version":2}}]"#)
            ),
            values(Some(r#"{"version":2}"#), None),
            None
        )
    );
    assert_eq!(
        render(PATHS_ONLY, V::Absent, V::Json(Value::Null)),
        content(
            diff_fields(MismatchDiff::Paths, Some(&[""]), Some(1), None),
            None,
            None
        )
    );
    // A stored null is a value, so it stays distinct from absence.
    assert_eq!(
        render(VALUES_ONLY, V::Absent, V::Json(Value::Null))
            .diff
            .unwrap()
            .diff_json
            .as_deref(),
        Some(r#"[{"path":"","source":null}]"#)
    );
    // Absence beside a side with no rendering is still a render failure.
    assert_eq!(
        render(EVERYTHING, V::Absent, V::Fails),
        content(failed_diff(EVERYTHING), values(None, None), RENDER_ERROR)
    );
    // A custom comparator may call two absent values different; no field differs.
    assert_eq!(
        render(EVERYTHING, V::Absent, V::Absent),
        content(
            diff_fields(MismatchDiff::Values, Some(&[]), Some(0), Some("[]")),
            values(None, None),
            None
        )
    );
    // The value-only prefix rendering recognizes the marker too.
    assert_eq!(
        render(VALUE_ONLY, V::Absent, source_user()),
        content(None, values(None, Some(SOURCE_USER_JSON)), None)
    );
}

#[test]
fn a_root_without_a_rendering_fails_the_fields_it_feeds_with_render_error() {
    let version = || V::Json(json!({"version": 2}));
    for unrenderable in [V::Fails, V::Panics] {
        assert_eq!(
            render(EVERYTHING, unrenderable.clone(), version()),
            content(
                failed_diff(EVERYTHING),
                values(None, Some(r#"{"version":2}"#)),
                RENDER_ERROR
            )
        );
        assert_eq!(
            render(EVERYTHING, version(), unrenderable.clone()),
            content(
                failed_diff(EVERYTHING),
                values(Some(r#"{"version":2}"#), None),
                RENDER_ERROR
            )
        );
        assert_eq!(
            render(PATHS_ONLY, version(), unrenderable.clone()),
            content(failed_diff(PATHS_ONLY), None, RENDER_ERROR)
        );
        assert_eq!(
            render(VALUE_ONLY, unrenderable, version()),
            content(None, values(None, Some(r#"{"version":2}"#)), RENDER_ERROR)
        );
    }
}

#[test]
fn each_side_is_serialized_once_for_every_field_it_feeds() {
    let (cached_renders, source_renders) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    assert_eq!(
        render(
            EVERYTHING,
            V::Counted(json!({"email": "a"}), cached_renders.clone()),
            V::Counted(json!({"email": "b"}), source_renders.clone()),
        ),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&["/email"]),
                Some(1),
                Some(r#"[{"path":"/email","cached":"a","source":"b"}]"#)
            ),
            values(Some(r#"{"email":"a"}"#), Some(r#"{"email":"b"}"#)),
            None
        )
    );
    assert_eq!(cached_renders.load(Ordering::SeqCst), 1);
    assert_eq!(source_renders.load(Ordering::SeqCst), 1);
}

#[test]
fn diff_json_is_clamped_to_8_kib_with_the_truncation_marker() {
    let (mut cached, mut source, mut entries) =
        (serde_json::Map::new(), serde_json::Map::new(), Vec::new());
    for index in 0..20 {
        let name = format!("m{index:02}");
        cached.insert(name.clone(), json!("x".repeat(500)));
        source.insert(name.clone(), json!("y".repeat(500)));
        entries.push(MismatchEntry {
            path: format!("/{name}"),
            cached: Some(json!("x".repeat(500))),
            source: Some(json!("y".repeat(500))),
        });
    }
    // The 8 KiB bound is the record's, so it is written out rather than taken
    // from the implementation's constant.
    let whole = serde_json::to_string(&entries).unwrap();
    let diff_json = format!(
        "{}{SHADOW_LOG_TRUNCATION_MARKER}",
        &whole[..8192 - SHADOW_LOG_TRUNCATION_MARKER.len()]
    );
    assert_eq!(diff_json.len(), 8192);
    assert_eq!(SHADOW_LOG_DIFF_MAX_BYTES, 8192);
    let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(
        render(
            VALUES_ONLY,
            V::Json(Value::Object(cached)),
            V::Json(Value::Object(source))
        ),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&paths),
                Some(20),
                Some(&diff_json)
            ),
            None,
            None
        )
    );
}

#[test]
fn a_rendering_too_deep_to_parse_fails_the_walk_closed_with_hook_error() {
    // serde_json parses at most 128 nested levels; the walk never falls back.
    let deep = || V::Json(nest_members(200, json!(1)));
    let deep_json = serde_json::to_string(&nest_members(200, json!(1))).unwrap();
    let content_of = render(EVERYTHING, deep(), V::Json(json!(1)));
    assert_eq!(content_of.diff, failed_diff(EVERYTHING));
    assert_eq!(content_of.failure, HOOK_ERROR);
    assert_eq!(
        content_of.values.unwrap().cached_value_json,
        Some(crate::preview::preview_value(&deep_json))
    );
    assert_eq!(
        render(PATHS_ONLY, V::Json(json!(1)), deep()),
        content(failed_diff(PATHS_ONLY), None, HOOK_ERROR)
    );
}

#[test]
fn the_hook_supplies_the_entries_and_the_walk_never_runs() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let renderers = with_hook(move |cached, source| {
        seen.fetch_add(1, Ordering::SeqCst);
        assert!(
            matches!((cached, source), (V::Json(c), V::Json(s)) if c["id"] == 1 && s["id"] == 2)
        );
        vec![
            MismatchEntry {
                path: "/profile/email".into(),
                cached: Some(json!("old@example.com")),
                source: Some(json!("new@example.com")),
            },
            MismatchEntry {
                path: "/roles".into(),
                cached: None,
                source: None,
            },
        ]
    });
    assert_eq!(
        render_with(
            EVERYTHING,
            V::Json(json!({"id": 1})),
            V::Json(json!({"id": 2})),
            &renderers
        ),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&["/profile/email", "/roles"]),
                Some(2),
                Some(
                    r#"[{"path":"/profile/email","cached":"old@example.com","source":"new@example.com"},{"path":"/roles"}]"#
                )
            ),
            values(Some(r#"{"id":1}"#), Some(r#"{"id":2}"#)),
            None
        )
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn neither_root_side_is_rendered_when_the_hook_supplies_the_entries_and_value_is_off() {
    let (cached_renders, source_renders) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    assert_eq!(
        render_with(
            VALUES_ONLY,
            V::Counted(json!("cached"), cached_renders.clone()),
            V::Counted(json!("source"), source_renders.clone()),
            &with_hook(|_, _| Vec::new()),
        ),
        content(
            diff_fields(MismatchDiff::Values, Some(&[]), Some(0), Some("[]")),
            None,
            None
        )
    );
    assert_eq!(cached_renders.load(Ordering::SeqCst), 0);
    assert_eq!(source_renders.load(Ordering::SeqCst), 0);
    // Hook paths without values need no rendering either, even of a value that has none.
    assert_eq!(
        render_with(
            PATHS_ONLY,
            cached_user(),
            V::Fails,
            &with_hook(|_, _| vec![MismatchEntry {
                path: "/version".into(),
                cached: None,
                source: None
            }])
        ),
        content(
            diff_fields(MismatchDiff::Paths, Some(&["/version"]), Some(1), None),
            None,
            None
        )
    );
}

#[test]
fn a_panicking_hook_fails_closed_with_hook_error_and_no_fallback() {
    let renderers = with_hook(|_, _| panic!("hook failed"));
    let user_values = values(Some(CACHED_USER_JSON), Some(SOURCE_USER_JSON));
    assert_eq!(
        render_with(EVERYTHING, cached_user(), source_user(), &renderers),
        content(failed_diff(EVERYTHING), user_values, HOOK_ERROR)
    );
    assert_eq!(
        render_with(PATHS_ONLY, cached_user(), source_user(), &renderers),
        content(failed_diff(PATHS_ONLY), None, HOOK_ERROR)
    );
    // A hook given values of another type fails the same way.
    let foreign: ErasedMismatchDiff = Arc::new(|_: &StoredValue, _: &StoredValue| None);
    let renderers = Renderers {
        hook: Some(foreign),
        ..json_renderers()
    };
    assert_eq!(
        render_with(PATHS_ONLY, cached_user(), source_user(), &renderers),
        content(failed_diff(PATHS_ONLY), None, HOOK_ERROR)
    );
}

#[test]
fn the_hook_is_not_called_when_diff_is_off() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let renderers = with_hook(move |_, _| {
        seen.fetch_add(1, Ordering::SeqCst);
        Vec::new()
    });
    assert_eq!(
        render_with(VALUE_ONLY, cached_user(), source_user(), &renderers),
        content(
            None,
            values(Some(CACHED_USER_JSON), Some(SOURCE_USER_JSON)),
            None
        )
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn hook_entries_omit_absent_sides_and_are_clamped_and_cut_at_64() {
    let long_path = format!("/{}", "k".repeat(600));
    let clamped_path = format!("/{}{SHADOW_LOG_TRUNCATION_MARKER}", "k".repeat(497));
    let hook_path = long_path.clone();
    let renderers = with_hook(move |_, _| {
        let mut entries = vec![MismatchEntry {
            path: hook_path.clone(),
            cached: Some(json!("x".repeat(2000))),
            source: Some(json!({"ok": true})),
        }];
        entries.extend((1..70).map(|index| MismatchEntry {
            path: format!("/{index}"),
            cached: None,
            source: None,
        }));
        entries
    });
    let fields = render_with(VALUES_ONLY, cached_user(), source_user(), &renderers);
    assert_eq!(fields.failure, None);
    let fields = fields.diff.unwrap();
    let retained: Vec<String> = (1..64).map(|index| format!("/{index}")).collect();
    let mut paths = vec![clamped_path.clone()];
    paths.extend(retained.iter().cloned());
    assert_eq!(fields.mismatch_paths, Some(paths));
    assert_eq!(fields.mismatch_path_count, Some(70));
    let mut expected = vec![json!({
        "path": clamped_path,
        "cached": format!("\"{}{SHADOW_LOG_TRUNCATION_MARKER}", "x".repeat(1009)),
        "source": {"ok": true},
    })];
    expected.extend(retained.iter().map(|path| json!({"path": path})));
    let logged: Value = serde_json::from_str(fields.diff_json.as_deref().unwrap()).unwrap();
    assert_eq!(logged, Value::Array(expected));

    let renderers = with_hook(|_, _| {
        vec![
            MismatchEntry {
                path: "/a".into(),
                cached: None,
                source: None,
            },
            MismatchEntry {
                path: "/b".into(),
                cached: Some(json!(1)),
                source: None,
            },
            MismatchEntry {
                path: "/c".into(),
                cached: None,
                source: Some(Value::Null),
            },
        ]
    });
    assert_eq!(
        render_with(VALUES_ONLY, cached_user(), source_user(), &renderers)
            .diff
            .unwrap()
            .diff_json
            .as_deref(),
        Some(r#"[{"path":"/a"},{"path":"/b","cached":1},{"path":"/c","source":null}]"#)
    );
}

#[test]
fn hook_entries_stay_when_a_root_side_has_no_rendering() {
    let renderers = with_hook(|_, _| {
        vec![MismatchEntry {
            path: "/a".into(),
            cached: None,
            source: None,
        }]
    });
    assert_eq!(
        render_with(EVERYTHING, V::Fails, source_user(), &renderers),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&["/a"]),
                Some(1),
                Some(r#"[{"path":"/a"}]"#)
            ),
            values(None, Some(SOURCE_USER_JSON)),
            RENDER_ERROR
        )
    );
}

#[test]
fn hook_error_ranks_above_render_error() {
    let renderers = with_hook(|_, _| panic!("hook failed"));
    assert_eq!(
        render_with(EVERYTHING, V::Fails, source_user(), &renderers),
        content(
            failed_diff(EVERYTHING),
            values(None, Some(SOURCE_USER_JSON)),
            HOOK_ERROR
        )
    );
}

#[test]
fn an_operation_without_json_needs_a_preview_and_a_hook() {
    let no_json = Renderers::default();
    assert_eq!(
        render_with(EVERYTHING, cached_user(), source_user(), &no_json),
        content(failed_diff(EVERYTHING), values(None, None), RENDER_ERROR)
    );
    assert!(!no_json.runs_code(EVERYTHING));
    let preview: ErasedPreview = Arc::new(|value: &StoredValue| match value.downcast_ref::<V>() {
        Some(V::User(user)) => Some(format!("preview {:?}", user.email)),
        _ => None,
    });
    let hook: ErasedMismatchDiff = Arc::new(|_: &StoredValue, _: &StoredValue| {
        Some(vec![MismatchEntry {
            path: "/email".into(),
            cached: None,
            source: None,
        }])
    });
    let custom = Renderers {
        json: None,
        preview: Some(preview),
        hook: Some(hook),
    };
    assert!(custom.runs_code(PATHS_ONLY));
    assert_eq!(
        render_with(EVERYTHING, cached_user(), source_user(), &custom),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&["/email"]),
                Some(1),
                Some(r#"[{"path":"/email"}]"#)
            ),
            values(
                Some(r#"preview "old@example.com""#),
                Some(r#"preview "new@example.com""#)
            ),
            None
        )
    );
}

#[test]
fn a_preview_replaces_the_value_fields_and_fails_closed_alone() {
    let preview: ErasedPreview = Arc::new(|value: &StoredValue| match value.downcast_ref::<V>() {
        Some(V::User(user)) if user.email == "new@example.com" => Some("🙂".repeat(10_000)),
        Some(V::User(_)) => None,
        _ => panic!("preview panicked"),
    });
    let renderers = Renderers {
        preview: Some(preview),
        ..json_renderers()
    };
    // The walk still compares the JSON renderings.
    assert_eq!(
        render_with(EVERYTHING, cached_user(), source_user(), &renderers),
        content(
            diff_fields(
                MismatchDiff::Values,
                Some(&["/email"]),
                Some(1),
                Some(
                    r#"[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]"#
                )
            ),
            values(
                None,
                Some(&crate::preview::preview_value(&"🙂".repeat(10_000)))
            ),
            RENDER_ERROR
        )
    );
    // A value the JSON rendering finds absent is never handed to the preview.
    assert_eq!(
        render_with(
            PATHS_ONLY.with_value(),
            V::Absent,
            source_user(),
            &renderers
        ),
        content(
            diff_fields(MismatchDiff::Paths, Some(&[""]), Some(1), None),
            values(
                None,
                Some(&crate::preview::preview_value(&"🙂".repeat(10_000)))
            ),
            None
        )
    );
}
