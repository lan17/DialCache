package dialcache

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"strconv"
	"testing"
)

func vectors(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	requireRegistry(t)
	raw, err := os.ReadFile("../formal/protocol-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var groups map[string]json.RawMessage
	if err := json.Unmarshal(raw, &groups); err != nil {
		t.Fatal(err)
	}
	var version int
	if err := json.Unmarshal(groups["schemaVersion"], &version); err != nil || version != 3 {
		t.Fatal("unsupported protocol vector schema")
	}
	return groups
}
func unhex(t *testing.T, value string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestProtocolKeys(t *testing.T) {
	groups := vectors(t)
	var valid []struct {
		Name                 string
		Input                Identity
		LogicalKey, ValueKey string
		WatermarkKey         *string
	}
	if err := json.Unmarshal(groups["keyVectors"], &valid); err != nil {
		t.Fatal(err)
	}
	for _, vector := range valid {
		t.Run(vector.Name, func(t *testing.T) {
			logical, value, watermark, err := vector.Input.Keys()
			if err != nil {
				t.Fatal(err)
			}
			wantWatermark := ""
			if vector.WatermarkKey != nil {
				wantWatermark = *vector.WatermarkKey
			}
			if logical != vector.LogicalKey || value != vector.ValueKey || watermark != wantWatermark {
				t.Fatalf("keys: got %q %q %q; want %q %q %q", logical, value, watermark, vector.LogicalKey, vector.ValueKey, wantWatermark)
			}
		})
	}
	var invalid []struct {
		Name  string
		Input json.RawMessage
	}
	if err := json.Unmarshal(groups["invalidKeyVectors"], &invalid); err != nil {
		t.Fatal(err)
	}
	for _, vector := range invalid {
		t.Run(vector.Name, func(t *testing.T) {
			var input Identity
			err := json.Unmarshal(vector.Input, &input)
			if err == nil {
				_, _, _, err = input.Keys()
			}
			if err == nil {
				t.Fatal("invalid key accepted")
			}
		})
	}
	t.Logf("keyVectors: %d/%d; invalidKeyVectors: %d/%d", len(valid), len(valid), len(invalid), len(invalid))
}

func TestProtocolFrames(t *testing.T) {
	var cases []struct {
		Name                                           string
		CreatedAtMS                                    uint64 `json:"createdAtMs"`
		PayloadType, PayloadUTF8, PayloadHex, FrameHex string
	}
	if err := json.Unmarshal(vectors(t)["frameVectors"], &cases); err != nil {
		t.Fatal(err)
	}
	for _, vector := range cases {
		t.Run(vector.Name, func(t *testing.T) {
			payload := []byte(vector.PayloadUTF8)
			if vector.PayloadType == "binary" {
				payload = unhex(t, vector.PayloadHex)
			}
			raw, err := EncodeFrame(Frame{CreatedAtMS: vector.CreatedAtMS, Binary: vector.PayloadType == "binary", Payload: payload})
			if err != nil {
				t.Fatal(err)
			}
			if actual := hex.EncodeToString(raw); actual != vector.FrameHex {
				t.Fatalf("frame: got %s, want %s", actual, vector.FrameHex)
			}
		})
	}
	t.Logf("frameVectors: %d/%d", len(cases), len(cases))
}

func TestProtocolDecoders(t *testing.T) {
	groups := vectors(t)
	for _, group := range []string{"trackedDecodeVectors", "untrackedDecodeVectors"} {
		t.Run(group, func(t *testing.T) {
			var cases []struct {
				Name          string
				FrameHex      *string
				WatermarkUTF8 *string
				Expected      json.RawMessage
			}
			if err := json.Unmarshal(groups[group], &cases); err != nil {
				t.Fatal(err)
			}
			for _, vector := range cases {
				t.Run(vector.Name, func(t *testing.T) {
					var raw []byte
					if vector.FrameHex != nil {
						raw = unhex(t, *vector.FrameHex)
					}
					result := DecodeFrame(raw, group == "trackedDecodeVectors", vector.WatermarkUTF8)
					actual := map[string]any{"kind": result.Kind}
					if result.Kind == "miss" {
						actual["reason"] = result.Reason
						if result.ObservedWatermarkMS != nil {
							actual["observedWatermarkMs"] = *result.ObservedWatermarkMS
						}
					}
					if result.Kind == "hit" {
						actual["createdAtMs"] = result.Frame.CreatedAtMS
						if result.Frame.Binary {
							actual["payloadType"] = "binary"
							actual["payloadHex"] = hex.EncodeToString(result.Frame.Payload)
						} else {
							actual["payloadType"] = "string"
							actual["payloadUtf8"] = string(result.Frame.Payload)
						}
					}
					// Compare JSON numbers as decimal text, retaining integer precision.
					encoded, err := json.Marshal(actual)
					if err != nil {
						t.Fatal(err)
					}
					var actualJSON, expectedJSON any
					decode := func(raw []byte, out *any) {
						t.Helper()
						decoder := json.NewDecoder(bytes.NewReader(raw))
						decoder.UseNumber()
						if err := decoder.Decode(out); err != nil {
							t.Fatal(err)
						}
					}
					decode(encoded, &actualJSON)
					decode(vector.Expected, &expectedJSON)
					if !reflect.DeepEqual(actualJSON, expectedJSON) {
						t.Fatalf("got %s\nwant %s", encoded, vector.Expected)
					}
				})
			}
			t.Logf("%s: %d/%d", group, len(cases), len(cases))
		})
	}
}

func TestProtocolCohorts(t *testing.T) {
	var cases []struct {
		Name   string
		Input  Identity
		Layer  string
		Sample float64
	}
	if err := json.Unmarshal(vectors(t)["rampVectors"], &cases); err != nil {
		t.Fatal(err)
	}
	for _, vector := range cases {
		t.Run(vector.Name, func(t *testing.T) {
			logical, _, _, err := vector.Input.Keys()
			if err != nil {
				t.Fatal(err)
			}
			if actual := Cohort(logical, vector.Layer); actual != vector.Sample {
				t.Fatalf("cohort got %.17g want %.17g", actual, vector.Sample)
			}
		})
	}
	t.Logf("rampVectors: %d/%d", len(cases), len(cases))
}

func TestProtocolRemainingVectors(t *testing.T) {
	groups := vectors(t)
	var durations []struct {
		Name     string
		Input    float64
		Expected *int64
	}
	if err := json.Unmarshal(groups["durationVectors"], &durations); err != nil {
		t.Fatal(err)
	}
	for _, v := range durations {
		t.Run(v.Name, func(t *testing.T) {
			got, err := CeilSupportedCacheTTLMS(v.Input)
			if v.Expected == nil {
				if err == nil {
					t.Fatal("invalid duration accepted")
				}
			} else if err != nil || got != *v.Expected {
				t.Fatalf("got %d %v want %d", got, err, *v.Expected)
			}
		})
	}
	var stamps []struct {
		Name  string
		Input float64
	}
	if err := json.Unmarshal(groups["invalidTimestampVectors"], &stamps); err != nil {
		t.Fatal(err)
	}
	for _, v := range stamps {
		t.Run(v.Name, func(t *testing.T) {
			if _, err := ValidateTimestampMS(v.Input); err == nil {
				t.Fatal("invalid timestamp accepted")
			}
		})
	}
	var normalize []struct {
		Name                    string
		Input                   map[string]any
		UndefinedSentinel       string
		BigintArgs, SpecialArgs map[string]string
		Expected                [][2]string
	}
	if err := json.Unmarshal(groups["normalizeArgsVectors"], &normalize); err != nil {
		t.Fatal(err)
	}
	for _, v := range normalize {
		t.Run(v.Name, func(t *testing.T) {
			for k, x := range v.Input {
				if v.UndefinedSentinel != "" && x == v.UndefinedSentinel {
					v.Input[k] = Absent
				}
			}
			for k, s := range v.BigintArgs {
				n, ok := new(big.Int).SetString(s, 10)
				if !ok {
					t.Fatal("invalid bigint fixture")
				}
				v.Input[k] = n
			}
			for k, s := range v.SpecialArgs {
				n, err := strconv.ParseFloat(s, 64)
				if err != nil {
					t.Fatal(err)
				}
				v.Input[k] = n
			}
			got, err := NormalizeArgs(v.Input)
			if err != nil || !reflect.DeepEqual(got, v.Expected) {
				t.Fatalf("got %#v %v want %#v", got, err, v.Expected)
			}
		})
	}
	var envelopes []struct{ Name, InputHex, EscapedHex, DecodedHex, Outcome string }
	if err := json.Unmarshal(groups["envelopeVectors"], &envelopes); err != nil {
		t.Fatal(err)
	}
	for _, v := range envelopes {
		t.Run(v.Name, func(t *testing.T) {
			raw := Payload{Bytes: unhex(t, v.InputHex), Binary: true}
			escaped := EscapeRawPayload(raw)
			if !bytes.Equal(escaped.Bytes, unhex(t, v.EscapedHex)) {
				t.Fatal("escape differs")
			}
			decoded := DecompressPayload(raw)
			if decoded.Outcome != v.Outcome || !decoded.Payload.Binary || !bytes.Equal(decoded.Payload.Bytes, unhex(t, v.DecodedHex)) {
				t.Fatalf("decoded %#v", decoded)
			}
			if !bytes.Equal(DecompressPayload(escaped).Payload.Bytes, raw.Bytes) {
				t.Fatal("escape roundtrip differs")
			}
		})
	}
	var decodes []struct{ Name, InputHex, PayloadType, PayloadUTF8, PayloadHex string }
	if err := json.Unmarshal(groups["compressedDecodeVectors"], &decodes); err != nil {
		t.Fatal(err)
	}
	for _, v := range decodes {
		t.Run(v.Name, func(t *testing.T) {
			got := DecompressPayload(Payload{Bytes: unhex(t, v.InputHex), Binary: true})
			want := []byte(v.PayloadUTF8)
			if v.PayloadType == "binary" {
				want = unhex(t, v.PayloadHex)
			}
			if got.Outcome != "decompressed" || got.Payload.Binary != (v.PayloadType == "binary") || !bytes.Equal(got.Payload.Bytes, want) {
				t.Fatalf("got %#v want %q", got, want)
			}
		})
	}
	var writes []struct {
		Name, PayloadType, PayloadUTF8, PayloadHex, Outcome string
		ThresholdBytes                                      int
	}
	if err := json.Unmarshal(groups["compressionWriteVectors"], &writes); err != nil {
		t.Fatal(err)
	}
	for _, v := range writes {
		t.Run(v.Name, func(t *testing.T) {
			raw := Payload{Bytes: []byte(v.PayloadUTF8), Binary: v.PayloadType == "binary"}
			if raw.Binary {
				raw.Bytes = unhex(t, v.PayloadHex)
			}
			got, err := CompressPayload(raw, CompressionConfig{v.ThresholdBytes, 3})
			if err != nil || got.Outcome != v.Outcome {
				t.Fatalf("got %#v %v", got, err)
			}
			decoded := DecompressPayload(got.Payload)
			if decoded.Payload.Binary != raw.Binary || !bytes.Equal(decoded.Payload.Bytes, raw.Bytes) {
				t.Fatal("compression changed value")
			}
			if got.Outcome == "compressed" {
				if !got.Payload.Binary || got.StoredBytes >= got.OriginalBytes {
					t.Fatal("compression grew")
				}
			} else if !bytes.Equal(got.Payload.Bytes, EscapeRawPayload(raw).Bytes) {
				t.Fatal("raw representation differs")
			}
		})
	}
	count := 0
	for group, raw := range groups {
		if group == "schemaVersion" {
			continue
		}
		var entries []json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil {
			t.Fatalf("unknown group %s", group)
		}
		count += len(entries)
	}
	if count != 134 {
		t.Fatalf("review protocol vector coverage: got %d expected 134", count)
	}
	t.Logf("all protocol groups exercised: %d vectors", count)
}
