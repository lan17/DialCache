package dialcache

import impl "github.com/lan17/DialCache/go/internal/dialcache"

const MaxSafeInteger = impl.MaxSafeInteger

const MaxSupportedDurationMS = impl.MaxSupportedDurationMS

const MaxTrackedValueTTLMS = impl.MaxTrackedValueTTLMS

// CeilSupportedCacheTTLMS is the adapter-level duration boundary. Fractional
// milliseconds round up, before checking the positive, 365-day limit.
func CeilSupportedCacheTTLMS(value float64) (int64, error) {
	return impl.CeilSupportedCacheTTLMS(value)
}

func ValidateTimestampMS(value float64) (uint64, error) {
	return impl.ValidateTimestampMS(value)
}

// NormalizeArgs omits Absent, converts the supported scalar domain using the
// JavaScript String rules, and orders names lexicographically by UTF-16 units.
// Arbitrary precision integers use big.Int; objects and arrays are rejected.
func NormalizeArgs(args map[string]any) ([][2]string, error) {
	return impl.NormalizeArgs(args)
}

// Identity is an already normalized logical identity. Ordered arguments retain
// caller order; normalization of host-language objects is a separate profile.
type Identity = impl.Identity

// Cohort preserves FNV-1a over UTF-16 code units, including surrogate pairs.
func Cohort(logical, discriminator string) float64 {
	return impl.Cohort(logical, discriminator)
}

type Frame = impl.Frame

type ReadResult = impl.ReadResult

func RawReadResult(value any) ReadResult {
	return impl.RawReadResult(value)
}

// NormalizeReadResult is the core trust boundary, above wire decoding. Miss
// reason and refill fence are validated independently. Frame-shaped objects
// ignore stray miss metadata; only kind:"miss" selects the miss branch.
func NormalizeReadResult(result ReadResult, tracked bool) ReadResult {
	return impl.NormalizeReadResult(result, tracked)
}

// EncodeFrame accepts only the writer timestamp domain. DecodeFrame retains
// uint64 precision and leaves the additional safe-timestamp check to the core.
func EncodeFrame(frame Frame) ([]byte, error) {
	return impl.EncodeFrame(frame)
}

// DecodeFrame implements the protocol's classification precedence. A nil raw
// value is absent; a present zero-length value is an unclassified miss.
func DecodeFrame(raw []byte, tracked bool, watermark *string) ReadResult {
	return impl.DecodeFrame(raw, tracked, watermark)
}
