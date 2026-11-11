package dialcache_test

import (
	"bytes"
	"context"
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

func (r *frameRemote) Read(context.Context, string, string) (ReadResult, error) {
	result := DecodeFrame(r.raw, false, nil)
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
