//! Logical identities, shared cache keys and rollout cohorts.
//!
//! Key construction follows the portable protocol (W01–W03): URI component
//! escaping, tracked entity hash tags, ordered argument pairs, the frame key
//! suffix, and FNV-1a cohorts over UTF-16 code units.

use std::cmp::Ordering;
use std::fmt::Write as _;

use crate::limits::FRAME_KEY_SUFFIX;

/// A normalized logical identity. Ordered arguments retain caller order;
/// use [`normalize_args`] to build them from a host-language record.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    /// The instance namespace; empty means the cache fills in its own at execution.
    #[serde(default)]
    pub namespace: String,
    /// The entity type; serialized as `keyType`.
    #[serde(rename = "keyType")]
    pub key_type: String,
    /// The entity identifier.
    pub id: String,
    /// The operation name; serialized as `useCase`.
    #[serde(rename = "useCase")]
    pub use_case: String,
    /// Whether the identity is fenced by its entity's invalidation watermark;
    /// serialized as `trackForInvalidation`. Defaults to false.
    #[serde(rename = "trackForInvalidation", default)]
    pub tracked: bool,
    /// Secondary dimensions as `(name, spelled value)` pairs, already
    /// normalized and in key order.
    #[serde(default)]
    pub args: Vec<(String, String)>,
}

impl Identity {
    /// An untracked identity with an empty namespace and no arguments.
    pub fn new(
        key_type: impl Into<String>,
        id: impl Into<String>,
        use_case: impl Into<String>,
    ) -> Self {
        Identity {
            namespace: String::new(),
            key_type: key_type.into(),
            id: id.into(),
            use_case: use_case.into(),
            tracked: false,
            args: Vec::new(),
        }
    }

    /// Set whether the identity shares its entity's invalidation watermark.
    pub fn tracked(mut self, tracked: bool) -> Self {
        self.tracked = tracked;
        self
    }

    /// Set the namespace explicitly instead of inheriting the instance's.
    pub fn namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = namespace.into();
        self
    }

    /// Replace the ordered argument pairs; build them with [`normalize_args`].
    pub fn args(mut self, args: Vec<(String, String)>) -> Self {
        self.args = args;
        self
    }

    /// The logical key, the stored value key and, for tracked identities, the watermark key.
    pub fn keys(&self) -> Result<Keys, IdentityError> {
        keys(self)
    }
}

/// Derived key strings of one identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keys {
    /// Logical key: `namespace:keyType:id[?args]#useCase`, hash-tagged when tracked.
    pub logical: String,
    /// Stored value key: the logical key plus the frame suffix.
    pub value: String,
    /// Entity watermark key for tracked identities.
    pub watermark: Option<String>,
}

/// Why an identity cannot form a key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdentityError {
    /// A component contains `{` or `}` where it would form the Redis Cluster
    /// hash tag: the namespace always, the key type and ID when tracked.
    #[error("DialCache identity component contains a reserved hash-tag delimiter")]
    ReservedDelimiter,
    /// An argument value cannot be spelled; the text names the offending value.
    #[error("DialCache identity contains an unsupported argument value: {0}")]
    UnsupportedArgument(String),
}

/// A host scalar accepted as a key argument.
#[derive(Debug, Clone, PartialEq)]
pub enum ArgValue {
    /// Omitted from the key (JavaScript `undefined`).
    Absent,
    /// JSON null, spelled `null`.
    Null,
    /// Spelled `true` or `false`.
    Bool(bool),
    /// Spelled with JavaScript `Number` formatting.
    Number(f64),
    /// Spelled as a decimal integer.
    Int(i64),
    /// An arbitrary-precision integer as decimal text.
    BigInt(String),
    /// Used verbatim, then percent-escaped like every other component.
    Str(String),
}

impl ArgValue {
    /// The JavaScript `String(value)` spelling, or `None` for an absent value.
    fn spell(self) -> Result<Option<String>, IdentityError> {
        Ok(Some(match self {
            ArgValue::Absent => return Ok(None),
            ArgValue::Null => "null".to_owned(),
            ArgValue::Bool(value) => if value { "true" } else { "false" }.to_owned(),
            ArgValue::Number(value) => js_number_to_string(value),
            ArgValue::Int(value) => value.to_string(),
            ArgValue::BigInt(text) => {
                if !is_decimal_integer(&text) {
                    return Err(IdentityError::UnsupportedArgument(format!(
                        "bigint text {text:?} is not a decimal integer"
                    )));
                }
                text
            }
            ArgValue::Str(text) => text,
        }))
    }
}

fn is_decimal_integer(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// Normalize a record of key arguments: omit absent values, spell scalars
/// the JavaScript way, and sort names by UTF-16 code units.
///
/// The sort is stable, so entries whose names compare equal keep their input order.
pub fn normalize_args<I, K>(args: I) -> Result<Vec<(String, String)>, IdentityError>
where
    I: IntoIterator<Item = (K, ArgValue)>,
    K: Into<String>,
{
    let mut pairs = Vec::new();
    for (name, value) in args {
        if let Some(text) = value.spell()? {
            pairs.push((name.into(), text));
        }
    }
    pairs.sort_by(|left, right| compare_utf16(&left.0, &right.0));
    Ok(pairs)
}

fn contains_brace(component: &str) -> bool {
    component.contains(['{', '}'])
}

/// Build every key of an identity.
///
/// The namespace may never contain a hash-tag brace. The key type and ID
/// are restricted the same way only when the identity is tracked, because
/// only then do they form the Redis Cluster hash tag; untracked braces are
/// percent-escaped like any other reserved character.
pub fn keys(identity: &Identity) -> Result<Keys, IdentityError> {
    if contains_brace(&identity.namespace)
        || (identity.tracked
            && (contains_brace(&identity.key_type) || contains_brace(&identity.id)))
    {
        return Err(IdentityError::ReservedDelimiter);
    }
    let entity = format!(
        "{}:{}:{}",
        escape_component(&identity.namespace),
        escape_component(&identity.key_type),
        escape_component(&identity.id)
    );
    let (mut logical, watermark) = if identity.tracked {
        let tagged = format!("{{{entity}}}");
        let watermark = format!("{tagged}#watermark");
        (tagged, Some(watermark))
    } else {
        (entity, None)
    };
    for (index, (name, value)) in identity.args.iter().enumerate() {
        logical.push(if index == 0 { '?' } else { '&' });
        logical.push_str(&escape_component(name));
        logical.push('=');
        logical.push_str(&escape_component(value));
    }
    logical.push('#');
    logical.push_str(&escape_component(&identity.use_case));
    let value = format!("{logical}{FRAME_KEY_SUFFIX}");
    Ok(Keys {
        logical,
        value,
        watermark,
    })
}

/// `encodeURIComponent` escaping of one component.
///
/// Bytes of the UTF-8 encoding are kept literally when they are
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )` and percent-encoded with uppercase hex otherwise.
pub fn escape_component(component: &str) -> String {
    let mut escaped = String::with_capacity(component.len());
    for byte in component.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            escaped.push(byte as char);
        } else {
            let _ = write!(escaped, "%{byte:02X}");
        }
    }
    escaped
}

/// FNV-1a 32-bit hash over the UTF-16 code units of `logical_key:discriminator`;
/// the integer numerator behind [`cohort`].
pub fn cohort_hash(logical_key: &str, discriminator: &str) -> u32 {
    let units = logical_key
        .encode_utf16()
        .chain(":".encode_utf16())
        .chain(discriminator.encode_utf16());
    units.fold(0x811c_9dc5_u32, |hash, unit| {
        (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193)
    })
}

/// Deterministic rollout sample in `[0, 100)` for a logical key and layer or
/// shadow discriminator: FNV-1a over the UTF-16 units of `key:discriminator`.
pub fn cohort(logical_key: &str, discriminator: &str) -> f64 {
    f64::from(cohort_hash(logical_key, discriminator)) / 4_294_967_296.0 * 100.0
}

/// Spell a number the way JavaScript's `String(number)` does.
///
/// This is ECMA-262 `Number::toString(10)`: the shortest digit string that
/// round-trips, laid out as plain decimal for exponents in `(-7, 21]` and as
/// `d.ddde±X` otherwise. Negative zero spells `0`.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let (digits, exponent) = shortest_digits(value.abs());
    let k = digits.len() as i32;
    let n = exponent + 1;
    let mut out = String::new();
    if value < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(n as usize);
        out.push_str(whole);
        out.push('.');
        out.push_str(fraction);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1);
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        let e = n - 1;
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        let _ = write!(out, "{}", e.abs());
    }
    out
}

/// The shortest round-trip decimal digits of a positive finite number and
/// the decimal exponent of its first digit: `value = 0.d1d2… × 10^(exponent+1)`.
fn shortest_digits(value: f64) -> (String, i32) {
    debug_assert!(value.is_finite() && value > 0.0);
    // Rust's `LowerExp` without a precision prints the shortest representation
    // that round-trips, as `d[.ddd]e[-]X`.
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp always includes an exponent");
    let mut digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let trimmed = digits.trim_end_matches('0').len().max(1);
    digits.truncate(trimmed);
    (
        digits,
        exponent
            .parse()
            .expect("LowerExp exponent is a decimal integer"),
    )
}

/// Compare two strings by UTF-16 code units, as JavaScript's `<` does.
pub fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers_follow_ecmascript_spelling() {
        let cases: &[(f64, &str)] = &[
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (0.0, "0"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (-1e-7, "-1e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (9007199254740991.0, "9007199254740991"),
            (1.25, "1.25"),
            (0.1, "0.1"),
            (1.2345e-7, "1.2345e-7"),
            (1.5e300, "1.5e+300"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (0.5, "0.5"),
            (123.456, "123.456"),
            (1e20, "100000000000000000000"),
        ];
        for (value, expected) in cases {
            assert_eq!(
                js_number_to_string(*value),
                *expected,
                "spelling of {value:?}"
            );
        }
    }

    #[test]
    fn escaping_matches_encode_uri_component() {
        assert_eq!(escape_component("é"), "%C3%A9");
        assert_eq!(escape_component("😀"), "%F0%9F%98%80");
        assert_eq!(escape_component("~!*'()-._"), "~!*'()-._");
        assert_eq!(
            escape_component("a b+c/d?e=f&g#h%"),
            "a%20b%2Bc%2Fd%3Fe%3Df%26g%23h%25"
        );
        assert_eq!(escape_component("{1}"), "%7B1%7D");
        assert_eq!(escape_component(""), "");
    }

    #[test]
    fn utf16_ordering_places_astral_before_private_use() {
        assert_eq!(compare_utf16("😀", "\u{e000}"), Ordering::Less);
        assert_eq!(compare_utf16("\u{ffff}", "😀"), Ordering::Greater);
        assert_eq!(compare_utf16("a", "ab"), Ordering::Less);
        assert_eq!(compare_utf16("b", "ab"), Ordering::Greater);
        assert_eq!(compare_utf16("", ""), Ordering::Equal);
    }

    #[test]
    fn normalization_spells_scalars_and_sorts_names() {
        let normalized = normalize_args(vec![
            ("z", ArgValue::Str("last".into())),
            ("missing", ArgValue::Absent),
            ("a", ArgValue::Int(1)),
            ("nil", ArgValue::Null),
            ("flag", ArgValue::Bool(false)),
            ("wide", ArgValue::BigInt("-9007199254740993".into())),
            ("tiny", ArgValue::Number(1e-7)),
        ])
        .unwrap();
        let expected: Vec<(String, String)> = [
            ("a", "1"),
            ("flag", "false"),
            ("nil", "null"),
            ("tiny", "1e-7"),
            ("wide", "-9007199254740993"),
            ("z", "last"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
        assert_eq!(normalized, expected);
    }

    #[test]
    fn malformed_bigint_text_is_rejected() {
        for text in ["", "-", "1.5", "0x10", "1e3", "+1", "１"] {
            assert!(
                matches!(
                    normalize_args(vec![("n", ArgValue::BigInt(text.into()))]),
                    Err(IdentityError::UnsupportedArgument(_))
                ),
                "bigint text {text:?} should be rejected"
            );
        }
    }

    #[test]
    fn braces_are_reserved_only_where_they_form_a_hash_tag() {
        let untracked = Identity::new("{kind}", "{1}", "Get").namespace("urn");
        assert_eq!(
            untracked.keys().unwrap().logical,
            "urn:%7Bkind%7D:%7B1%7D#Get"
        );
        assert_eq!(
            untracked.clone().tracked(true).keys(),
            Err(IdentityError::ReservedDelimiter)
        );
        assert_eq!(
            Identity::new("k", "1", "Get").namespace("bad{ns").keys(),
            Err(IdentityError::ReservedDelimiter)
        );
        let tracked = Identity::new("user_id", "123", "GetUser")
            .namespace("users-api")
            .tracked(true)
            .args(vec![("locale".into(), "en".into())]);
        let keys = tracked.keys().unwrap();
        assert_eq!(keys.logical, "{users-api:user_id:123}?locale=en#GetUser");
        assert_eq!(
            keys.value,
            "{users-api:user_id:123}?locale=en#GetUser:dialcache-frame-v1"
        );
        assert_eq!(
            keys.watermark.as_deref(),
            Some("{users-api:user_id:123}#watermark")
        );
    }

    #[test]
    fn cohort_is_fnv1a_over_utf16_units() {
        assert_eq!(cohort_hash("urn:id:1#Get", "local"), 1_652_509_740);
        assert_eq!(cohort("urn:id:1#Get", "local"), 38.475490640848875);
        assert_eq!(cohort_hash("", ""), {
            let mut hash = 0x811c_9dc5_u32;
            hash ^= u32::from(b':');
            hash.wrapping_mul(0x0100_0193)
        });
    }
}
