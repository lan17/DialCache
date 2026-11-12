package dialcache_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"math/rand/v2"
	"runtime"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	. "github.com/lan17/DialCache/go"
)

// crashingZstdFrame is the two-block frame from the regression test for
// GHSA-fpmh-frq8-7rj8; klauspost/compress before v1.20.2 panics decoding it.
func crashingZstdFrame() []byte {
	return slices.Concat(
		[]byte{0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38, 0x74, 0x06, 0x00, 0x42, 0xb8, 0x32, 0x0d, 0x1a, 0x00, 0x00, 0x00, 0x90, 0xaf, 0xfa, 0xff, 0x03, 0x00, 0x80, 0xff, 0x7f},
		bytes.Repeat([]byte{0xa5, 0x94, 0x52, 0x4a, 0x29}, 37),
		[]byte{0xa5, 0x94, 0x12, 0x00, 0xad, 0x56, 0x03, 0xee, 0xff, 0xdf, 0xb3, 0x1a, 0x1c, 0x1a, 0x00, 0xe0, 0xff, 0x1f, 0x0f, 0xb1, 0x9c, 0x5a, 0xcf, 0x4d, 0xe4, 0x1d, 0x7b, 0xab, 0x99, 0x5e, 0x01, 0x51, 0xa4, 0x73, 0xd8, 0xb1, 0xf3, 0x39, 0x4b, 0x67, 0xf6, 0xab, 0x1a, 0xab, 0x1a, 0xab, 0x1a},
		bytes.Repeat([]byte{0x8c, 0x31, 0xc6, 0x18, 0x63}, 1365),
		[]byte{0x8c, 0x31},
		bytes.Repeat([]byte{0x63, 0x8c, 0x31, 0xc6, 0x18}, 1365),
		[]byte{0x63, 0x2c},
		bytes.Repeat([]byte{0x31, 0xc6, 0x18, 0x63, 0x8c}, 1365),
		[]byte{0x31, 0x46},
		bytes.Repeat([]byte{0x31, 0xc6, 0x18, 0x63, 0x8c}, 1365),
		[]byte{0x31, 0x06, 0x00},
	)
}

type frameRemote struct {
	raw    []byte
	writes int
}

func (r *frameRemote) Read(_ context.Context, _, watermarkKey string) (ReadResult, error) {
	result := DecodeFrame(r.raw, watermarkKey != "", nil)
	return result, result.Error()
}
func (r *frameRemote) Write(_ context.Context, _ string, frame Frame, _ time.Duration) error {
	raw, err := EncodeFrame(frame)
	r.raw, r.writes = raw, r.writes+1
	return err
}
func (*frameRemote) Invalidate(context.Context, string, int64, int64) error { return nil }

func TestCorruptCompressedFrameFailsOpen(t *testing.T) {
	for _, coalesce := range []bool{true, false} {
		raw, err := EncodeFrame(Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Binary: true, Payload: append([]byte{1}, crashingZstdFrame()...)})
		if err != nil {
			t.Fatal(err)
		}
		remote := &frameRemote{raw: raw}
		var errors []any
		cache := MustNew(WithRemote(remote), WithObserver(func(event Event) {
			if event.Kind == "error" {
				errors = append(errors, event.Data["error"])
			}
		}))
		ctx, done := cache.Enable(context.Background())
		value, err := GetOrLoad(ctx, cache, Operation[string]{
			Identity: Identity{Namespace: "test", KeyType: "entity", ID: "1", UseCase: "read"},
			Policy:   Policy{RemoteTTL: time.Minute, Coalesce: &coalesce},
		}, func(context.Context) (string, error) { return "source", nil })
		done()
		if value != "source" || err != nil || remote.writes != 1 || !slices.Equal(errors, []any{"serialization_load"}) {
			t.Fatalf("coalesce=%v: value=%q err=%v writes=%d errors=%v", coalesce, value, err, remote.writes, errors)
		}
	}
}

// Pooled zstd encoders are shared across goroutines, so they must hold no
// channel: using a channel made inside a testing/synctest bubble from outside
// that bubble is a fatal error.
func TestCompressPayloadAcrossSynctestBubbles(t *testing.T) {
	value := Payload{Bytes: []byte(strings.Repeat("dialcache ", 1000))}
	roundTrip := func(t *testing.T) {
		compressed, err := CompressPayload(value, CompressionConfig{ThresholdBytes: 1, Level: 3})
		if err != nil || compressed.Outcome != "compressed" {
			t.Fatal(compressed.Outcome, err)
		}
		if decoded := DecompressPayload(compressed.Payload); decoded.Outcome != "decompressed" || !bytes.Equal(decoded.Payload.Bytes, value.Bytes) {
			t.Fatal(decoded.Outcome)
		}
	}
	synctest.Test(t, roundTrip)
	roundTrip(t)
	synctest.Test(t, roundTrip)
}

// Values at and above the zstd block size (64 KiB at levels 1-2, 128 KiB
// otherwise) take the encoder's multi-block path, and every write after the
// first reuses a pooled encoder.
func TestCompressPayloadRoundTripsAcrossBlockSizes(t *testing.T) {
	random := make([]byte, 3<<17+1)
	_, _ = rand.NewChaCha8([32]byte{1}).Read(random)
	text := []byte(strings.Repeat(`{"id":"item-17","group":"north","state":"active"},`, len(random)/48+1))
	for _, level := range []int{1, 3} {
		for _, size := range []int{1<<16 - 1, 1 << 16, 1<<16 + 1, 1<<17 - 1, 1 << 17, 1<<17 + 1, 3<<17 + 1} {
			for _, input := range []struct {
				name, outcome string
				bytes         []byte
			}{{"mixed", "compressed", append(text[:size/2:size/2], random[:size-size/2]...)}, {"random", "not_smaller", random[:size]}} {
				for range 2 {
					written, err := CompressPayload(Payload{Binary: true, Bytes: input.bytes}, CompressionConfig{ThresholdBytes: 1, Level: level})
					if err != nil || written.Outcome != input.outcome {
						t.Fatalf("level %d, %s %d bytes: outcome %q, error %v", level, input.name, size, written.Outcome, err)
					}
					read := DecompressPayload(written.Payload)
					if !read.Payload.Binary || !bytes.Equal(read.Payload.Bytes, input.bytes) {
						t.Fatalf("level %d, %s %d bytes: read %q did not return the written value", level, input.name, size, read.Outcome)
					}
				}
			}
		}
	}
}

// rleZstdFrame returns a zstd frame with the given frame header descriptor and
// window or content size fields, holding n copies of b in RLE blocks of at most
// 128 KiB.
func rleZstdFrame(header []byte, b byte, n int) []byte {
	frame := append([]byte{0x28, 0xb5, 0x2f, 0xfd}, header...)
	for {
		size := min(n, 128<<10)
		n -= size
		block := uint32(1)<<1 | uint32(size)<<3
		if n == 0 {
			block |= 1
		}
		frame = append(frame, byte(block), byte(block>>8), byte(block>>16), b)
		if n == 0 {
			return frame
		}
	}
}

// declaredWindow is a frame header that declares a 2^windowLog window and no
// content size, so the decoder sizes its history from the window.
func declaredWindow(windowLog int) []byte { return []byte{0x00, byte((windowLog - 10) << 3)} }

// singleSegment is a frame header with an 8-byte content size and no window
// descriptor, which bounds the window by the content size.
func singleSegment(size int) []byte {
	return binary.LittleEndian.AppendUint64([]byte{0xe0}, uint64(size))
}

func measure(f func()) (allocated uint64, elapsed time.Duration) {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	start := time.Now()
	f()
	elapsed = time.Since(start)
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc, elapsed
}

// The decoder allocates a frame's declared window before it reads a block, so
// a stored value of a few bytes could force a 512 MiB allocation on every read.
// Reads accept the largest window the TypeScript reader accepts and reject a
// larger one without allocating it.
func TestDecompressPayloadRejectsWindowsLargerThanTheTypeScriptReader(t *testing.T) {
	for _, marker := range []byte{1, 2} {
		accepted := DecompressPayload(Payload{Binary: true, Bytes: append([]byte{marker}, rleZstdFrame(declaredWindow(27), 'x', 1)...)})
		if accepted.Outcome != "decompressed" || string(accepted.Payload.Bytes) != "x" {
			t.Fatalf("marker %d, 128 MiB window: outcome %q, payload %q", marker, accepted.Outcome, accepted.Payload.Bytes)
		}
		for _, windowLog := range []int{28, 29} {
			stored := append([]byte{marker}, rleZstdFrame(declaredWindow(windowLog), 'x', 1)...)
			var read CompressionReadResult
			allocated, elapsed := measure(func() { read = DecompressPayload(Payload{Binary: true, Bytes: stored}) })
			if read.Outcome != "read_over_limit" || !bytes.Equal(read.Payload.Bytes, stored) || allocated > 1<<20 || elapsed > 100*time.Millisecond {
				t.Fatalf("marker %d, %d MiB window: outcome %q, %d bytes allocated in %v", marker, 1<<(windowLog-20), read.Outcome, allocated, elapsed)
			}
		}
	}
}

// A single-segment frame's window is its content size. Reads accept the same
// sizes as libzstd's default reader limit, (1<<27)+1 bytes; libzstd and
// klauspost write a single-segment frame only when the content fits the window.
func TestDecompressPayloadMatchesLibzstdSingleSegmentLimit(t *testing.T) {
	const size = 128<<20 + 1
	read := DecompressPayload(Payload{Binary: true, Bytes: append([]byte{2}, rleZstdFrame(singleSegment(size), 'x', size)...)})
	if read.Outcome != "decompressed" || len(read.Payload.Bytes) != size {
		t.Fatalf("%d bytes: outcome %q, %d bytes", size, read.Outcome, len(read.Payload.Bytes))
	}
	stored := append([]byte{2}, rleZstdFrame(singleSegment(size+1), 'x', size+1)...)
	if read := DecompressPayload(Payload{Binary: true, Bytes: stored}); read.Outcome != "read_over_limit" || !bytes.Equal(read.Payload.Bytes, stored) {
		t.Fatalf("%d bytes: outcome %q", size+1, read.Outcome)
	}
}

// Writers that store uncompressed values still read frames marked as zstd, so
// the window bound holds on a tracked, remote-only read too.
func TestOversizedZstdWindowFailsOpenWithoutAllocating(t *testing.T) {
	raw, err := EncodeFrame(Frame{CreatedAtMS: uint64(time.Now().UnixMilli()), Binary: true, Payload: append([]byte{2}, rleZstdFrame(declaredWindow(29), 'x', 1)...)})
	if err != nil {
		t.Fatal(err)
	}
	remote := &frameRemote{raw: raw}
	var errors []any
	cache := MustNew(WithRemote(remote), WithoutCompression(), WithLocalCapacity(0), WithObserver(func(event Event) {
		if event.Kind == "error" {
			errors = append(errors, event.Data["error"])
		}
	}))
	coalesce := false
	ctx, done := cache.Enable(context.Background())
	var value string
	allocated, _ := measure(func() {
		value, err = GetOrLoad(ctx, cache, Operation[string]{
			Identity: Identity{Namespace: "test", KeyType: "entity", ID: "1", UseCase: "read", Tracked: true},
			Policy:   Policy{RemoteTTL: time.Minute, Coalesce: &coalesce},
		}, func(context.Context) (string, error) { return "source", nil })
	})
	done()
	if value != "source" || err != nil || remote.writes != 1 || !slices.Equal(errors, []any{"serialization_load"}) || allocated > 16<<20 {
		t.Fatalf("value=%q err=%v writes=%d errors=%v allocated=%d", value, err, remote.writes, errors, allocated)
	}
}

// The read limit counts decoded bytes, and each ill-formed UTF-8 byte then
// becomes a 3-byte U+FFFD. A 16 KiB frame of 512 MiB of 0xFF would otherwise
// return 1.5 GiB of text, so the replaced text must also fit the 512 MiB cap.
func TestDecompressPayloadBoundsReplacedText(t *testing.T) {
	stored := append([]byte{1}, rleZstdFrame(declaredWindow(17), 0xff, MaxDecompressedBytes)...)
	var read CompressionReadResult
	allocated, elapsed := measure(func() { read = DecompressPayload(Payload{Binary: true, Bytes: stored}) })
	if read.Outcome != "read_over_limit" || !bytes.Equal(read.Payload.Bytes, stored) || allocated > 5<<30 {
		t.Fatalf("outcome %q, %d bytes returned, %d bytes allocated in %v", read.Outcome, len(read.Payload.Bytes), allocated, elapsed)
	}
}
