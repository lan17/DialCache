package dialcache

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// Expected values never enter this driver. Known API failures are observations;
// request, process and serialization failures fail the worker itself.
func TestVectorBoundaryDriver(t *testing.T) {
	path := os.Getenv("DIALCACHE_VECTOR_REQUEST")
	if path == "" {
		t.Skip("no selected vector")
	}
	out := os.Getenv("DIALCACHE_VECTOR_OUT")
	if out == "" {
		t.Fatal("DIALCACHE_VECTOR_OUT is required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Operation string
		Input     json.RawMessage
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	var actual any
	switch request.Operation {
	case "key":
		var input Identity
		if err := json.Unmarshal(request.Input, &input); err != nil {
			t.Fatal(err)
		}
		logical, value, watermark, err := input.Keys()
		if err != nil {
			if err.Error() != "identity contains a reserved hash-tag delimiter" {
				t.Fatal(err)
			}
			actual = map[string]any{"kind": "key_error"}
		} else {
			var observedWatermark any
			if input.Tracked {
				observedWatermark = watermark
			}
			actual = map[string]any{"kind": "key", "logicalKey": logical, "valueKey": value, "watermarkKey": observedWatermark}
		}
	case "trackedDecode":
		var input struct{ FrameHex, WatermarkUTF8 *string }
		if err := json.Unmarshal(request.Input, &input); err != nil {
			t.Fatal(err)
		}
		var frame []byte
		if input.FrameHex != nil {
			frame = unhex(t, *input.FrameHex)
		}
		result := DecodeFrame(frame, true, input.WatermarkUTF8)
		value := map[string]any{"kind": result.Kind}
		if result.Kind == "miss" {
			value["reason"] = result.Reason
			if result.ObservedWatermarkMS != nil {
				value["observedWatermarkMs"] = *result.ObservedWatermarkMS
			}
		}
		if result.Kind == "hit" {
			value["createdAtMs"] = result.Frame.CreatedAtMS
			if result.Frame.Binary {
				value["payloadType"] = "binary"
				value["payloadHex"] = hex.EncodeToString(result.Frame.Payload)
			} else {
				value["payloadType"] = "string"
				value["payloadUtf8"] = string(result.Frame.Payload)
			}
		}
		actual = value
	case "envelope":
		var input struct{ InputHex string }
		if err := json.Unmarshal(request.Input, &input); err != nil {
			t.Fatal(err)
		}
		result := DecompressPayload(Payload{Bytes: unhex(t, input.InputHex), Binary: true})
		actual = map[string]any{"decodedHex": hex.EncodeToString(result.Payload.Bytes), "outcome": result.Outcome}
	case "compression":
		var input struct {
			PayloadType, PayloadUTF8, PayloadHex string
			ThresholdBytes, MaxDecompressedBytes int
		}
		if err := json.Unmarshal(request.Input, &input); err != nil {
			t.Fatal(err)
		}
		payload := Payload{Bytes: []byte(input.PayloadUTF8), Binary: input.PayloadType == "binary"}
		if payload.Binary {
			payload.Bytes = unhex(t, input.PayloadHex)
		}
		result, err := CompressPayload(payload, CompressionConfig{ThresholdBytes: input.ThresholdBytes, Level: 3}, input.MaxDecompressedBytes)
		if err != nil {
			t.Fatal(err)
		}
		marker := -1
		if result.Outcome == "compressed" {
			marker = int(result.Payload.Bytes[0])
		}
		actual = map[string]any{"outcome": result.Outcome, "storedBytes": result.StoredBytes, "marker": marker}
	default:
		t.Fatal("unknown vector operation", request.Operation)
	}
	encoded, err := json.Marshal(map[string]any{"actual": actual})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(encoded, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}
