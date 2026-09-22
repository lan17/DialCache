//! Native allocation and codec-ownership boundaries for acquired remote frames.
use super::*;
use crate::operation::{downcast_value, erase_load, Operation};
use crate::testing::{TestExecutor, WALL_EPOCH_MS};
use crate::{Codec, DialCache, InvalidateRequest, Payload, Policy, Remote};
use futures::channel::oneshot;
use parking_lot::Mutex;

struct OneRead(Mutex<Option<Frame>>);
impl Remote for OneRead {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(std::future::ready(Ok(ReadResult::Hit(
            self.0.lock().take().unwrap(),
        ))))
    }
    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        panic!("this test only reads")
    }
    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        panic!("this test only reads")
    }
}
struct GatedCodec {
    gate: Mutex<Option<oneshot::Receiver<()>>>,
    input: Settled<usize>,
}
impl Codec<u64> for GatedCodec {
    fn encode(&self, _: &u64) -> BoxFuture<'_, Result<Payload, BoxError>> {
        panic!("this test only decodes")
    }
    fn decode(&self, mut payload: Payload) -> BoxFuture<'_, Result<u64, BoxError>> {
        let gate = self.gate.lock().take().unwrap();
        Box::pin(async move {
            self.input.settle(payload.bytes.as_ptr() as usize);
            payload.bytes[0] = 99;
            gate.await?;
            Ok(payload.len() as u64)
        })
    }
}
fn hit(result: RawRead) -> Arc<Frame> {
    match result.unwrap() {
        ReadSnapshot::Hit(frame) => frame,
        ReadSnapshot::Miss { .. } => panic!("expected a hit"),
    }
}

#[test]
fn acquired_frames_share_storage_while_a_gated_codec_owns_an_independent_input() {
    for ready_first in [false, true] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let payload = Payload::binary(vec![42; 128 * 1024]);
        let original_buffer = payload.bytes.as_ptr() as usize;
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(executor.runtime.clone())
            .remote(OneRead(Mutex::new(Some(Frame {
                created_at_ms: WALL_EPOCH_MS as u64,
                payload,
            }))))
            .build()
            .unwrap();
        let (release, gate) = oneshot::channel();
        let codec = Arc::new(GatedCodec {
            gate: Mutex::new(Some(gate)),
            input: Settled::new(),
        });
        let (identity, metadata) = Operation::with_codec(
            Identity::new("thing", "one", "ReadSnapshot"),
            codec.clone(),
            |a, b| a == b,
        )
        .policy(Policy::default().remote_ttl_sec(60))
        .erase();
        let keys = identity.keys().unwrap();
        let policy = resolve_policy(
            &metadata.policy,
            None,
            &keys.logical,
            PolicyDefaults {
                remote_read_timeout_ms: 100,
            },
        )
        .unwrap();
        let request = cache.enable_guard();
        let execution = Arc::new(Execution {
            core: cache.core.clone(),
            scope: request.scope().clone(),
            op: Arc::new(ErasedOperation {
                identity: identity.clone(),
                identity_provider: None,
                metadata,
                load: erase_load(|_| async { Ok(0u64) }),
            }),
            labels: crate::engine::outcome_labels(&identity),
            identity,
            keys,
            policy,
        });
        let (bounded, raw) = execution.raw_read();
        if ready_first {
            executor.drain();
        }
        // The two schedules cover the deadline cell's ready peek and pending wait.
        let frame = hit(executor.block_on(bounded));
        let observed = hit(raw.peek().unwrap());
        assert!(Arc::ptr_eq(&frame, &observed));
        assert_eq!(frame.payload.bytes.as_ptr() as usize, original_buffer);
        let weak = Arc::downgrade(&frame);
        let (done, receive) = oneshot::channel();
        let decoding = execution.clone();
        let decoding_frame = frame.clone();
        executor.spawn(async move {
            let result = decoding.decode(&decoding_frame, Layer::Remote, None).await;
            done.send(result).unwrap();
        });
        executor.drain();
        assert_ne!(codec.input.peek().expect("codec started"), original_buffer);
        assert!(
            frame.payload.bytes.iter().all(|byte| *byte == 42),
            "codec mutation leaked into the retained snapshot"
        );
        let cleanup = hit(executor.block_on(async move { raw.wait().await }));
        assert!(
            Arc::ptr_eq(&frame, &cleanup),
            "cleanup must observe the shared allocation"
        );
        release.send(()).unwrap();
        let value = executor.block_on(async move { receive.await.unwrap().unwrap() });
        assert_eq!(*downcast_value::<u64>(value).unwrap(), 128 * 1024);
        drop((frame, observed, cleanup));
        assert!(
            weak.upgrade().is_none(),
            "completed observers retained the frame"
        );
    }
}
