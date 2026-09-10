package dialcache

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func vectors(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	requireRegistry(t)
	raw, err := os.ReadFile("../protocol-vectors.json")
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
