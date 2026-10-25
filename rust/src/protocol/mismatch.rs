//! The built-in confirmed-mismatch difference: a walk over two JSON values
//! that reports RFC 6901 pointers with the sides found there.

use std::fmt::Write;

use serde_json::Value;

use crate::identity::compare_utf16;
use crate::operation::MismatchEntry;
use crate::preview::{
    clamp_utf8, SHADOW_MISMATCH_MAX_DEPTH, SHADOW_MISMATCH_MAX_ENTRIES,
    SHADOW_MISMATCH_PATH_MAX_BYTES, SHADOW_MISMATCH_SIDE_MAX_BYTES,
};

/// The capped built-in difference list and its uncut length.
#[derive(Debug, Clone, PartialEq)]
pub struct MismatchJsonDiff {
    /// Bounded entries in walk order, at most
    /// [`SHADOW_MISMATCH_MAX_ENTRIES`](crate::preview::SHADOW_MISMATCH_MAX_ENTRIES).
    pub entries: Vec<MismatchEntry>,
    /// Every difference the walk found, before the cut.
    pub count: u64,
}

/// The built-in difference computation over two JSON values.
///
/// Objects recurse over the union of their member names in UTF-16 code-unit
/// order, and a member present on one side only is reported at its pointer
/// with that side. Arrays of equal length recurse by index; arrays of
/// different length are reported once at their own pointer. Any other
/// differing pair, roots of different kinds included, is reported at its
/// pointer with both sides, and a differing pair of containers at
/// [`SHADOW_MISMATCH_MAX_DEPTH`](crate::preview::SHADOW_MISMATCH_MAX_DEPTH)
/// reference tokens is reported whole without descending. Numbers compare by
/// value as doubles, so `1` and `1.0` are equal. Entries keep walk order and
/// are cut at
/// [`SHADOW_MISMATCH_MAX_ENTRIES`](crate::preview::SHADOW_MISMATCH_MAX_ENTRIES);
/// `count` is the uncut total. Each pointer is clamped to
/// [`SHADOW_MISMATCH_PATH_MAX_BYTES`](crate::preview::SHADOW_MISMATCH_PATH_MAX_BYTES),
/// and a side whose JSON exceeds
/// [`SHADOW_MISMATCH_SIDE_MAX_BYTES`](crate::preview::SHADOW_MISMATCH_SIDE_MAX_BYTES)
/// becomes its clamped JSON text as a string.
pub fn diff_shadow_mismatch_json(cached: &Value, source: &Value) -> MismatchJsonDiff {
    let walk = walk_json(cached, source);
    MismatchJsonDiff {
        entries: walk
            .entries
            .iter()
            .map(|entry| bound_entry(&entry.path, entry.cached, entry.source, true))
            .collect(),
        count: walk.count,
    }
}

/// The difference between two renderings, `None` for an absent side. Equal
/// texts have no entries; one absent side is reported whole at the root.
/// `with_values` keeps the bounded sides; without it entries carry paths only.
pub(crate) fn diff_rendered(
    cached: Option<&str>,
    source: Option<&str>,
    with_values: bool,
) -> Result<MismatchJsonDiff, serde_json::Error> {
    if cached == source {
        return Ok(MismatchJsonDiff {
            entries: Vec::new(),
            count: 0,
        });
    }
    let cached: Option<Value> = cached.map(serde_json::from_str).transpose()?;
    let source: Option<Value> = source.map(serde_json::from_str).transpose()?;
    let (cached, source) = match (&cached, &source) {
        (Some(cached), Some(source)) => (cached, source),
        _ => {
            return Ok(MismatchJsonDiff {
                entries: vec![bound_entry(
                    "",
                    cached.as_ref(),
                    source.as_ref(),
                    with_values,
                )],
                count: 1,
            })
        }
    };
    let walk = walk_json(cached, source);
    Ok(MismatchJsonDiff {
        entries: walk
            .entries
            .iter()
            .map(|entry| bound_entry(&entry.path, entry.cached, entry.source, with_values))
            .collect(),
        count: walk.count,
    })
}

/// The one clamp rule for built-in and hook entries: the pointer is clamped,
/// and with `with_values` each present side is kept as JSON, or as its
/// clamped text when its rendering exceeds the side cap.
pub(crate) fn bound_entry(
    path: &str,
    cached: Option<&Value>,
    source: Option<&Value>,
    with_values: bool,
) -> MismatchEntry {
    let side = |value: Option<&Value>| value.filter(|_| with_values).map(bound_side);
    MismatchEntry {
        path: clamp_utf8(path, SHADOW_MISMATCH_PATH_MAX_BYTES),
        cached: side(cached),
        source: side(source),
    }
}

fn bound_side(value: &Value) -> Value {
    match serde_json::to_string(value) {
        Ok(json) if json.len() > SHADOW_MISMATCH_SIDE_MAX_BYTES => {
            Value::String(clamp_utf8(&json, SHADOW_MISMATCH_SIDE_MAX_BYTES))
        }
        _ => value.clone(),
    }
}

/// One difference as the walk holds it, before the clamps.
struct RawEntry<'a> {
    path: String,
    cached: Option<&'a Value>,
    source: Option<&'a Value>,
}

/// One unescaped reference token of the pointer to the walk's position.
#[derive(Clone, Copy)]
enum Token<'a> {
    Index(usize),
    Name(&'a str),
}

struct Walk<'a> {
    entries: Vec<RawEntry<'a>>,
    count: u64,
    /// The pointer to the current position, as tokens, so descending costs
    /// no copy of the prefix.
    tokens: Vec<Token<'a>>,
}

impl<'a> Walk<'a> {
    fn report(&mut self, cached: Option<&'a Value>, source: Option<&'a Value>) {
        self.count += 1;
        if self.entries.len() < SHADOW_MISMATCH_MAX_ENTRIES {
            self.entries.push(RawEntry {
                path: self.pointer(),
                cached,
                source,
            });
        }
    }

    /// The escaped pointer to the current position, built only as far as
    /// [`SHADOW_MISMATCH_PATH_MAX_BYTES`] reads: past the cap it stops at a
    /// character boundary, and that prefix clamps as the whole pointer would.
    /// So a retained entry costs at most the cap, however long and deep the
    /// member names above it.
    fn pointer(&self) -> String {
        let mut pointer = String::new();
        for token in &self.tokens {
            if pointer.len() > SHADOW_MISMATCH_PATH_MAX_BYTES {
                break;
            }
            pointer.push('/');
            match *token {
                Token::Index(index) => {
                    let _ = write!(pointer, "{index}");
                }
                Token::Name(name) => {
                    for c in name.chars() {
                        if pointer.len() > SHADOW_MISMATCH_PATH_MAX_BYTES {
                            break;
                        }
                        match c {
                            '~' => pointer.push_str("~0"),
                            '/' => pointer.push_str("~1"),
                            c => pointer.push(c),
                        }
                    }
                }
            }
        }
        pointer
    }

    fn walk(&mut self, left: &'a Value, right: &'a Value) {
        let kind = Kind::of(left);
        if kind != Kind::of(right) || kind == Kind::Primitive {
            if !primitives_equal(left, right) {
                self.report(Some(left), Some(right));
            }
            return;
        }
        if self.tokens.len() >= SHADOW_MISMATCH_MAX_DEPTH {
            if !json_values_equal(left, right) {
                self.report(Some(left), Some(right));
            }
            return;
        }
        match (left, right) {
            (Value::Array(left_items), Value::Array(right_items)) => {
                if left_items.len() != right_items.len() {
                    self.report(Some(left), Some(right));
                    return;
                }
                for (index, (l, r)) in left_items.iter().zip(right_items).enumerate() {
                    self.tokens.push(Token::Index(index));
                    self.walk(l, r);
                    self.tokens.pop();
                }
            }
            (Value::Object(left_members), Value::Object(right_members)) => {
                let mut names: Vec<&String> = left_members.keys().collect();
                names.extend(
                    right_members
                        .keys()
                        .filter(|name| !left_members.contains_key(*name)),
                );
                names.sort_by(|a, b| compare_utf16(a, b));
                for name in names {
                    self.tokens.push(Token::Name(name));
                    match (left_members.get(name), right_members.get(name)) {
                        (Some(l), Some(r)) => self.walk(l, r),
                        (l, r) => self.report(l, r),
                    }
                    self.tokens.pop();
                }
            }
            _ => unreachable!("both values share a container kind"),
        }
    }
}

fn walk_json<'a>(cached: &'a Value, source: &'a Value) -> Walk<'a> {
    let mut walk = Walk {
        entries: Vec::new(),
        count: 0,
        tokens: Vec::new(),
    };
    walk.walk(cached, source);
    walk
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Array,
    Object,
    Primitive,
}

impl Kind {
    fn of(value: &Value) -> Kind {
        match value {
            Value::Array(_) => Kind::Array,
            Value::Object(_) => Kind::Object,
            _ => Kind::Primitive,
        }
    }
}

/// JSON primitive equality as JavaScript's `===` sees parsed JSON: numbers by
/// their double value, everything else exactly.
fn primitives_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(l), Value::Number(r)) => l.as_f64() == r.as_f64(),
        _ => left == right,
    }
}

// Structural equality for a depth-capped pair, iterative so that a subtree as
// deep as the parser allows cannot exhaust the stack.
fn json_values_equal(cached: &Value, source: &Value) -> bool {
    let mut pending = vec![(cached, source)];
    while let Some((left, right)) = pending.pop() {
        match (left, right) {
            (Value::Array(l), Value::Array(r)) => {
                if l.len() != r.len() {
                    return false;
                }
                pending.extend(l.iter().zip(r));
            }
            (Value::Object(l), Value::Object(r)) => {
                if l.len() != r.len() {
                    return false;
                }
                for (name, value) in l {
                    let Some(other) = r.get(name) else {
                        return false;
                    };
                    pending.push((value, other));
                }
            }
            _ => {
                if Kind::of(left) != Kind::of(right) || !primitives_equal(left, right) {
                    return false;
                }
            }
        }
    }
    true
}
