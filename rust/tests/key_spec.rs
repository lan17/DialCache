//! Native entity-ID conversion at the registered-use-case API boundary.

// Borrowed input support is part of the public contract exercised below.
#![allow(clippy::needless_borrows_for_generic_args)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{DialCache, IntoKeyId, KeySpec, Policy};

#[test]
fn floating_ids_use_javascript_spelling_for_owned_and_borrowed_inputs() {
    for (value, expected) in [
        (-0.0, "0"),
        (1e-7, "1e-7"),
        (1e21, "1e+21"),
        (f64::from_bits(0x430c6bf526340002), "1000000000000000.2"),
        (f64::from_bits(0xc30c6bf526340002), "-1000000000000000.2"),
        (f64::INFINITY, "Infinity"),
        (f64::NAN, "NaN"),
    ] {
        assert_eq!(KeySpec::new(value).id, expected);
        assert_eq!(KeySpec::new(&value).id, expected);
        assert_eq!(KeySpec::from(value).id, expected);
    }
}

#[test]
fn single_precision_ids_are_promoted_to_javascript_numbers() {
    for (value, expected) in [(-0.0_f32, "0"), (0.1_f32, "0.10000000149011612")] {
        assert_eq!(KeySpec::new(value).id, expected);
        assert_eq!(KeySpec::new(&value).id, expected);
        assert_eq!(KeySpec::from(value).id, expected);
    }
}

#[test]
fn string_and_integer_ids_keep_their_text_and_support_references() {
    let text = String::from("001e+21");
    let borrowed_text = text.as_str();
    assert_eq!(KeySpec::new(text.as_str()).id, text);
    assert_eq!(KeySpec::new(&borrowed_text).id, text);
    assert_eq!(KeySpec::new(&text).id, text);
    assert_eq!(KeySpec::new(text.clone()).id, text);
    assert_eq!(KeySpec::from(text.clone()).id, text);
    assert_eq!(KeySpec::new(&42_u64).id, "42");
    assert_eq!(KeySpec::new(&i128::MIN).id, i128::MIN.to_string());
    assert_eq!(KeySpec::new(u128::MAX).id, u128::MAX.to_string());
    assert_eq!(KeySpec::from(u128::MAX).id, u128::MAX.to_string());

    // A custom Display type retains the explicit text escape hatch.
    assert_eq!(
        KeySpec::new(std::net::Ipv4Addr::LOCALHOST.to_string()).id,
        "127.0.0.1"
    );
    assert_eq!(42_u64.into_key_id(), "42");
}

#[test]
fn registered_float_ids_share_the_javascript_zero_identity() {
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .build()
        .unwrap();
    let sources = Arc::new(AtomicUsize::new(0));
    let calls = sources.clone();
    let lookup = cache
        .use_case::<f64, usize>("thing", "FloatId")
        .policy(Policy::default().local_ttl_sec(60))
        .key(|id: &f64| KeySpec::new(id))
        .source(move |_, _| {
            let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Ok(value) }
        })
        .register()
        .unwrap();
    let (negative, positive) = executor.block_on(async move {
        let request = cache.enable_guard();
        let negative = lookup.get(request.scope(), -0.0).await.unwrap();
        let positive = lookup.get(request.scope(), 0.0).await.unwrap();
        (negative, positive)
    });
    assert_eq!((*negative, *positive), (1, 1));
    assert_eq!(sources.load(Ordering::SeqCst), 1);
}
