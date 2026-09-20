//! Native scalar conversion at the secondary-key argument API boundary.

// Borrowed inputs are part of the public contract exercised below.
#![allow(clippy::needless_borrows_for_generic_args)]

use dialcache::{normalize_args, ArgValue, Identity, KeySpec};

fn normalized(value: impl Into<ArgValue>) -> String {
    let key = KeySpec::new("entity").arg("value", value);
    normalize_args(key.args).unwrap().remove(0).1
}

#[test]
fn unsigned_and_wide_integer_arguments_preserve_every_decimal_digit() {
    assert_eq!(normalized(9_007_199_254_740_993_u64), "9007199254740993");
    assert_eq!(normalized(u64::MAX), "18446744073709551615");
    assert_eq!(
        normalized(i128::MIN),
        "-170141183460469231731687303715884105728"
    );
    assert_eq!(
        normalized(i128::MAX),
        "170141183460469231731687303715884105727"
    );
    assert_eq!(
        normalized(u128::MAX),
        "340282366920938463463374607431768211455"
    );
    assert_eq!(normalized(usize::MAX), usize::MAX.to_string());
    assert_eq!(normalized(isize::MIN), isize::MIN.to_string());
    assert_eq!(normalized(isize::MAX), isize::MAX.to_string());
}

#[test]
fn every_integer_primitive_accepts_zero_and_its_extremes() {
    macro_rules! check {
        ($($t:ty),*) => { $(
            assert_eq!(normalized(0 as $t), "0", stringify!($t));
            assert_eq!(normalized(<$t>::MIN), <$t>::MIN.to_string(), stringify!($t));
            assert_eq!(normalized(<$t>::MAX), <$t>::MAX.to_string(), stringify!($t));
        )* };
    }
    check!(i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);
}

#[test]
fn arguments_keep_float_boolean_string_and_optional_scalar_semantics() {
    for (value, expected) in [
        (0.1_f32, "0.10000000149011612"),
        (-0.0_f32, "0"),
        (f32::INFINITY, "Infinity"),
        (f32::NEG_INFINITY, "-Infinity"),
        (f32::NAN, "NaN"),
    ] {
        assert_eq!(normalized(value), expected);
    }
    assert_eq!(
        normalized(f64::from_bits(0x430c6bf526340002)),
        "1000000000000000.2"
    );
    assert_eq!(normalized(false), "false");
    assert_eq!(normalized(true), "true");
    assert_eq!(normalized("001e+21"), "001e+21");
    assert_eq!(normalized(String::from("001e+21")), "001e+21");
    assert_eq!(normalized(ArgValue::Null), "null");

    let key = KeySpec::new("entity")
        .arg("present", Some(u128::MAX))
        .arg("omitted", None::<u128>)
        .arg("absent", ArgValue::Absent);
    assert_eq!(
        normalize_args(key.args).unwrap(),
        vec![(
            "present".into(),
            "340282366920938463463374607431768211455".into()
        )]
    );
}

#[test]
fn wide_arguments_form_distinct_keys_without_float_rounding() {
    let key = |value: u128| {
        let specification = KeySpec::new("id").arg("version", value);
        Identity::new("entity", specification.id, "lookup")
            .namespace("urn")
            .args(normalize_args(specification.args).unwrap())
            .keys()
            .unwrap()
            .logical
    };
    assert_eq!(
        key(u128::MAX),
        "urn:entity:id?version=340282366920938463463374607431768211455#lookup"
    );
    assert_eq!(
        key(u128::MAX - 1),
        "urn:entity:id?version=340282366920938463463374607431768211454#lookup"
    );
}

#[test]
fn borrowed_arguments_preserve_owned_scalar_spellings() {
    let text = String::from("001e+21");
    let borrowed_text = text.as_str();
    assert_eq!(normalized(&text), text);
    assert_eq!(normalized(&borrowed_text), text);
    assert_eq!(normalized(&u64::MAX), "18446744073709551615");
    assert_eq!(normalized(&usize::MAX), usize::MAX.to_string());
    assert_eq!(
        normalized(&u128::MAX),
        "340282366920938463463374607431768211455"
    );
    assert_eq!(normalized(&0.1_f32), "0.10000000149011612");
    assert_eq!(normalized(&false), "false");
    assert_eq!(normalized(&Some(u64::MAX)), "18446744073709551615");
    let key = KeySpec::new("entity").arg("omitted", &None::<u64>);
    assert!(normalize_args(key.args).unwrap().is_empty());
}
