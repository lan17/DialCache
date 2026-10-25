//! Pins the built-in mismatch walk's pointer cost: it builds pointer text
//! only for the entries it retains, and only as far as the pointer cap
//! reads, so a deep chain of long member names over a wide array costs no
//! copying per visited member.
//!
//! A counting allocator measures the bytes the walk allocates on the test's
//! own thread, so the bound holds however fast the machine is.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use dialcache::preview::{SHADOW_MISMATCH_MAX_ENTRIES, SHADOW_MISMATCH_PATH_MAX_BYTES};
use dialcache::protocol::diff_shadow_mismatch_json;
use serde_json::{json, Value};

struct CountingAllocator;

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}

fn count(bytes: usize) {
    let _ = ALLOCATED.try_with(|allocated| allocated.set(allocated.get() + bytes));
}

// SAFETY: every call forwards to the system allocator unchanged.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(new_size);
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocated_by<R>(work: impl FnOnce() -> R) -> (R, usize) {
    let before = ALLOCATED.with(Cell::get);
    let result = work();
    (result, ALLOCATED.with(Cell::get) - before)
}

/// 31 levels of one 1 KiB member name over a 10,000-element array, so every
/// array element sits under a 31 KiB pointer prefix.
fn long_name_chain(items: Vec<Value>) -> Value {
    let name = "k".repeat(1024);
    let mut value = Value::Array(items);
    for _ in 0..31 {
        value = json!({ name.clone(): value });
    }
    value
}

#[test]
fn pointer_text_is_built_only_for_retained_entries_and_only_up_to_the_cap() {
    const ITEMS: usize = 10_000;
    const DIFFERING: usize = 100;
    let cached = long_name_chain((0..ITEMS).map(|index| json!(index)).collect());
    let source = long_name_chain(
        (0..ITEMS)
            .map(|index| json!(if index < ITEMS - DIFFERING { index } else { 0 }))
            .collect(),
    );

    let (diff, bytes) = allocated_by(|| diff_shadow_mismatch_json(&cached, &source));

    assert_eq!(diff.count, DIFFERING as u64);
    assert_eq!(diff.entries.len(), SHADOW_MISMATCH_MAX_ENTRIES);
    assert!(diff
        .entries
        .iter()
        .all(|entry| entry.path.len() <= SHADOW_MISMATCH_PATH_MAX_BYTES
            && entry.path.starts_with("/kkk")));
    // Copying the prefix for every visited member allocates over 300 MB here,
    // and building each retained pointer whole about 4 MB; the walk itself
    // needs well under 1 MiB.
    assert!(bytes < 1 << 20, "the walk allocated {bytes} bytes");
}
