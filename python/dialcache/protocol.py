"""DialCache version-1 frames and payload envelopes, independent of Redis clients."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from .errors import DialCacheError
from .key import _scalar_text
from .serializer import Payload

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_SUPPORTED_DURATION_MS = 31_536_000_000
MAX_TRACKED_REDIS_VALUE_TTL_MS = 3_600_000
MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024


class RedisPayloadError(DialCacheError):
    """A Redis reply is not a bulk byte string or nil."""


class RedisPayloadEncodingError(DialCacheError):
    """An eligible frame carries an unsupported payload encoding."""


class RedisProtocolError(DialCacheError):
    """Redis returned an unexpected command reply."""


@dataclass(frozen=True)
class Frame:
    created_at_ms: int
    payload: Payload


@dataclass(frozen=True)
class Miss:
    reason: str
    observed_watermark_ms: int | None = None
    kind: str = field(default="miss", init=False)


ReadResult = Frame | Miss


def valid_timestamp(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 0 <= value <= MAX_SAFE_INTEGER
        and value == int(value)
    )


def validate_timestamp(value: object) -> int:
    if not valid_timestamp(value):
        raise ValueError("DialCache timestamp must be a nonnegative safe integer")
    return int(value)  # type: ignore[arg-type]


def ceil_supported_cache_ttl_ms(value: float) -> int:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not 0 < value <= MAX_SUPPORTED_DURATION_MS
    ):
        raise ValueError("DialCache Redis TTL must be a positive finite duration")
    result = math.ceil(value)
    if not 0 < result <= MAX_SUPPORTED_DURATION_MS:
        raise ValueError("DialCache Redis TTL must be positive and no greater than 365 days")
    return result


def validate_future_buffer_ms(value: object) -> int:
    result = validate_timestamp(value)
    if result > MAX_SUPPORTED_DURATION_MS:
        raise ValueError("DialCache future buffer must be no greater than 365 days")
    return result


def utf8_bytes(value: str) -> bytes:
    return _scalar_text(value, replace=True).encode("utf-8")


def _payload_bytes(payload: Payload) -> bytes:
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, str):
        return utf8_bytes(payload)
    raise TypeError("DialCache serializer payload must be str or immutable bytes")


def encode_frame(payload: Payload, created_at_ms: int) -> bytes:
    timestamp = validate_timestamp(created_at_ms)
    return (
        b"\x01"
        + timestamp.to_bytes(8, "big")
        + bytes([int(isinstance(payload, bytes))])
        + _payload_bytes(payload)
    )


def _bulk(raw: object) -> bytes | None:
    if raw is None or isinstance(raw, bytes):
        return raw
    raise RedisPayloadError("Invalid Redis read reply; expected immutable bytes or None")


def _supported(raw: bytes) -> bool:
    return len(raw) >= 10 and raw[0] == 1


def _watermark(raw: bytes | None) -> int | None:
    if raw is None or not re.fullmatch(rb"[0-9]+", raw):
        return None
    # Avoid Python's decimal conversion guard on hostile or huge numeric strings.
    digits = raw.lstrip(b"0") or b"0"
    if len(digits) > 16 or (len(digits) == 16 and digits > b"9007199254740991"):
        return None
    return int(digits)


def _frame(raw: bytes) -> Frame:
    tag = raw[9]
    if tag == 0:
        payload: Payload = raw[10:].decode("utf-8", errors="replace")
    elif tag == 1:
        payload = raw[10:]
    else:
        raise RedisPayloadEncodingError("Invalid DialCache Redis payload encoding")
    return Frame(int.from_bytes(raw[1:9], "big"), payload)


def decode_read(raw: object) -> ReadResult:
    frame = _bulk(raw)
    if frame is None:
        return Miss("value_absent")
    if not _supported(frame):
        return Miss("unclassified")
    return _frame(frame)


def decode_tracked_read(raw: object, raw_watermark: object) -> ReadResult:
    frame, watermark_bytes = _bulk(raw), _bulk(raw_watermark)
    watermark = _watermark(watermark_bytes)
    if frame is None:
        return Miss("value_absent", watermark)
    if not _supported(frame):
        return Miss("unclassified", watermark)
    if watermark_bytes is not None and watermark is None:
        return Miss("unclassified")
    timestamp = int.from_bytes(frame[1:9], "big")
    if timestamp == 0:
        return Miss("unclassified", watermark)
    if watermark is not None and timestamp <= watermark:
        return Miss("watermark_fenced", watermark)
    return _frame(frame)


def validate_set_reply(reply: object) -> None:
    # redis-py maps the native OK status to True through its SET response callback.
    if reply is not True and reply not in ("OK", b"OK"):
        raise RedisProtocolError("Invalid Redis SET reply; expected OK")


def validate_invalidation_reply(reply: object) -> None:
    if type(reply) is not int or reply != 1:
        raise RedisProtocolError("Invalid Redis invalidate reply; expected integer 1")


@dataclass(frozen=True)
class CompressionResult:
    payload: Payload
    outcome: str
    original_bytes: int
    stored_bytes: int


@dataclass(frozen=True)
class DecompressionResult:
    payload: Payload
    outcome: str


def escape_raw_payload(payload: Payload) -> Payload:
    _payload_bytes(payload)
    return b"\x00" + payload if isinstance(payload, bytes) and payload and payload[0] <= 2 else payload


def compress_payload(
    payload: Payload, threshold_bytes: int = 4096, level: int = 3, maximum: int = MAX_DECOMPRESSED_BYTES
) -> CompressionResult:
    import zstandard

    raw = _payload_bytes(payload)
    escaped = escape_raw_payload(payload)
    stored_size = len(_payload_bytes(escaped))
    if len(raw) < threshold_bytes:
        return CompressionResult(escaped, "below_threshold", len(raw), stored_size)
    if len(raw) > maximum:
        return CompressionResult(escaped, "write_over_limit", len(raw), stored_size)
    encoded = zstandard.ZstdCompressor(level=level).compress(raw)
    if len(encoded) + 1 >= stored_size:
        return CompressionResult(escaped, "not_smaller", len(raw), stored_size)
    result = bytes([2 if isinstance(payload, bytes) else 1]) + encoded
    return CompressionResult(result, "compressed", len(raw), len(result))


def decompress_payload(payload: Payload, maximum: int = MAX_DECOMPRESSED_BYTES) -> DecompressionResult:
    if not isinstance(payload, bytes) or not payload:
        return DecompressionResult(payload, "passthrough")
    marker = payload[0]
    if marker == 0:
        value = payload[1:] if len(payload) > 1 and payload[1] <= 2 else payload
        return DecompressionResult(value, "passthrough")
    if marker not in (1, 2):
        return DecompressionResult(payload, "passthrough")
    import io

    import zstandard

    try:
        encoded = payload[1:]
        content_size = zstandard.frame_content_size(encoded)
        unknown_size = content_size in (-1, zstandard.CONTENTSIZE_UNKNOWN)
        if unknown_size or content_size > maximum:
            # The one-shot decoder ignores max_output_size when the header
            # declares a size. Probe at most cap+1 bytes before allowing an
            # allocation, and stop at the first frame just as Node does. A
            # truncated large frame remains fallback_raw rather than being
            # classified from an untrusted header alone.
            with zstandard.ZstdDecompressor().stream_reader(
                io.BytesIO(encoded), read_across_frames=False
            ) as reader:
                prefix = reader.read(maximum + 1)
            if len(prefix) > maximum:
                return DecompressionResult(payload, "read_over_limit")
            del prefix
            if not unknown_size:
                return DecompressionResult(payload, "fallback_raw")
        decoded = zstandard.ZstdDecompressor().decompress(
            encoded, max_output_size=max(1, maximum), allow_extra_data=True
        )
        if len(decoded) > maximum:
            return DecompressionResult(payload, "read_over_limit")
    except (zstandard.ZstdError, ValueError, OverflowError, OSError):
        return DecompressionResult(payload, "fallback_raw")
    return DecompressionResult(
        decoded.decode("utf-8", errors="replace") if marker == 1 else decoded, "decompressed"
    )
