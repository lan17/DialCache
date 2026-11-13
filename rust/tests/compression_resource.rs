use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dialcache::limits::MAX_DECOMPRESSED_BYTES;
use dialcache::observe::CompressionOutcome;
use dialcache::protocol::{decode_frame, decompress_payload, encode_frame};
use dialcache::{
    BoxError, DialCache, Event, Frame, Identity, InvalidateRequest, Observer, Operation, Payload,
    Policy, ReadContext, ReadRequest, ReadResult, Remote, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

fn expanding_text() -> Payload {
    // A 128 KiB window and 1536 RLE blocks: 192 MiB of FF becomes 576 MiB of UTF-8.
    let mut bytes = vec![1, 0x28, 0xb5, 0x2f, 0xfd, 0, 0x38];
    for block in 0..1536 {
        let header = 2u32 | ((128 << 10) << 3) | u32::from(block == 1535);
        bytes.extend_from_slice(&header.to_le_bytes()[..3]);
        bytes.push(0xff);
    }
    assert_eq!(bytes.len(), 6151);
    assert_eq!(
        hex::encode(Sha256::digest(&bytes)),
        "87f67ab328f41b853343257bbc461bc52fd432b0ccca15ec19ba5772019c08c0"
    );
    Payload::binary(bytes)
}

#[test]
fn repaired_text_cannot_exceed_the_global_read_limit() {
    let original = expanding_text();
    let result = decompress_payload(original.clone(), MAX_DECOMPRESSED_BYTES);
    assert_eq!(result.outcome, Some(CompressionOutcome::ReadOverLimit));
    assert_eq!(result.payload, original);
}

struct FrameRemote {
    bytes: Vec<u8>,
    writes: AtomicUsize,
}

impl Remote for FrameRemote {
    fn read(
        &self,
        request: ReadRequest,
        _: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async move {
            assert!(request.watermark_key.is_some());
            Ok(decode_frame(Some(&self.bytes), true, None)?)
        })
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        assert_eq!(request.frame.payload, Payload::text("\"source\""));
        self.writes.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        unreachable!("the read must not invalidate")
    }
}

#[derive(Default)]
struct CompressionEvents(Mutex<Vec<CompressionOutcome>>);

impl Observer for CompressionEvents {
    fn observe(&self, event: &Event) {
        if let Event::Compression { outcome, .. } = event {
            self.0.lock().push(*outcome);
        }
    }
}

#[tokio::test]
async fn disabled_compression_still_bounds_text_and_fails_open() {
    let remote = Arc::new(FrameRemote {
        bytes: encode_frame(&Frame {
            created_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            payload: expanding_text(),
        })
        .unwrap(),
        writes: AtomicUsize::new(0),
    });
    assert_eq!(remote.bytes.len(), 6161);
    let events = Arc::new(CompressionEvents::default());
    let cache = DialCache::builder()
        .remote_arc(remote.clone())
        .observer_arc(events.clone())
        .local_capacity(0)
        .disable_compression()
        .build()
        .unwrap();
    let guard = cache.enable_guard();
    let operation =
        Operation::<String>::new(Identity::new("item", "oversized", "read").tracked(true))
            .policy(Policy::default().remote_ttl_sec(60));
    let calls = Arc::new(AtomicUsize::new(0));
    let source_calls = calls.clone();
    let value = tokio::time::timeout(
        Duration::from_secs(30),
        cache.get_or_load(guard.scope(), operation, move |_| {
            source_calls.fetch_add(1, Ordering::SeqCst);
            async { Ok("source".to_string()) }
        }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&*value, "source");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(remote.writes.load(Ordering::SeqCst), 1);
    assert_eq!(*events.0.lock(), [CompressionOutcome::ReadOverLimit]);
}
