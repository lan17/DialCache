"""Replay every fixed and generated portable wire vector against the real API."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import zstandard

from dialcache.key import Key, normalize_args, ramp_hash, ramp_sample
from dialcache.protocol import (
    Frame,
    Miss,
    RedisPayloadEncodingError,
    ceil_supported_cache_ttl_ms,
    compress_payload,
    decode_read,
    decode_tracked_read,
    decompress_payload,
    encode_frame,
    escape_raw_payload,
    utf8_bytes,
)
from dialcache.serializer import UNDEFINED

ROOT = Path(__file__).resolve().parents[2]
CORPORA = [
    json.loads((ROOT / "formal" / name).read_text())
    for name in (
        "protocol-vectors.json",
        "quint-key-vectors.json",
        "quint-frame-vectors.json",
        "quint-envelope-vectors.json",
    )
]


def vectors(group):
    return [pytest.param(vector, id=vector["name"]) for corpus in CORPORA for vector in corpus.get(group, [])]


def payload(vector):
    return bytes.fromhex(vector["payloadHex"]) if vector["payloadType"] == "binary" else vector["payloadUtf8"]


def key_from(vector):
    value = vector["input"]
    return Key(
        namespace=value["namespace"],
        key_type=value["keyType"],
        id=value["id"],
        use_case=value["useCase"],
        args=value["args"],
        tracked=value["trackForInvalidation"],
    )


def test_schemas_provenance_and_inventory():
    assert all(corpus["schemaVersion"] == 3 for corpus in CORPORA)
    expected_counts = [134, 457, 589, 297]
    for corpus, expected in zip(CORPORA, expected_counts, strict=True):
        rows = [row for value in corpus.values() if isinstance(value, list) for row in value]
        assert len(rows) == expected
        for path, expected_hash in corpus.get("provenance", {}).get("sourceSha256", {}).items():
            assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected_hash, path


@pytest.mark.parametrize("vector", vectors("keyVectors"))
def test_keys(vector):
    key = key_from(vector)
    assert key.logical == vector["logicalKey"]
    assert key.value_key == vector["valueKey"]
    assert key.watermark_key == vector["watermarkKey"]


@pytest.mark.parametrize("vector", vectors("invalidKeyVectors"))
def test_invalid_keys(vector):
    with pytest.raises((ValueError, TypeError)):
        key_from(vector)


@pytest.mark.parametrize("vector", vectors("normalizeArgsVectors"))
def test_normalize_args(vector):
    values = {
        name: UNDEFINED if "undefinedSentinel" in vector and value == vector["undefinedSentinel"] else value
        for name, value in vector["input"].items()
    }
    values.update({name: int(value) for name, value in vector.get("bigintArgs", {}).items()})
    values.update({name: float(value) for name, value in vector.get("specialArgs", {}).items()})
    assert normalize_args(values) == tuple(tuple(pair) for pair in vector["expected"])


@pytest.mark.parametrize("vector", vectors("rampVectors"))
def test_rollout(vector):
    key = key_from(vector)
    assert ramp_sample(key, vector["layer"]) == vector["sample"]
    if "hashNumerator" in vector:
        assert ramp_hash(key, vector["layer"]) == vector["hashNumerator"]


@pytest.mark.parametrize("vector", vectors("frameVectors"))
def test_encode(vector):
    assert encode_frame(payload(vector), vector["createdAtMs"]).hex() == vector["frameHex"]


@pytest.mark.parametrize("vector", vectors("invalidTimestampVectors"))
def test_invalid_timestamp(vector):
    value = float(vector["specialInput"]) if "specialInput" in vector else vector["input"]
    with pytest.raises(ValueError):
        encode_frame("value", value)


@pytest.mark.parametrize("vector", vectors("durationVectors"))
def test_duration(vector):
    value = float(vector["specialInput"]) if "specialInput" in vector else vector["input"]
    if vector["expected"] is None:
        with pytest.raises(ValueError):
            ceil_supported_cache_ttl_ms(value)
    else:
        assert ceil_supported_cache_ttl_ms(value) == vector["expected"]


def assert_decode(vector, *, tracked):
    raw = None if vector["frameHex"] is None else bytes.fromhex(vector["frameHex"])
    watermark = vector.get("watermarkUtf8")

    def decode():
        return (
            decode_tracked_read(raw, None if watermark is None else watermark.encode())
            if tracked
            else decode_read(raw)
        )

    expected = vector["expected"]
    if expected["kind"] == "payload_encoding_error":
        with pytest.raises(RedisPayloadEncodingError):
            decode()
    elif expected["kind"] == "miss":
        assert decode() == Miss(expected["reason"], expected.get("observedWatermarkMs"))
    else:
        assert decode() == Frame(expected["createdAtMs"], payload(expected))


@pytest.mark.parametrize("vector", vectors("trackedDecodeVectors"))
def test_tracked_decode(vector):
    assert_decode(vector, tracked=True)


@pytest.mark.parametrize("vector", vectors("untrackedDecodeVectors"))
def test_untracked_decode(vector):
    assert_decode(vector, tracked=False)


@pytest.mark.parametrize("vector", vectors("envelopeVectors"))
def test_envelopes(vector):
    raw = bytes.fromhex(vector["inputHex"])
    escaped = bytes.fromhex(vector["escapedHex"])
    assert escape_raw_payload(raw) == escaped
    result = decompress_payload(raw)
    assert result.payload == bytes.fromhex(vector["decodedHex"])
    assert result.outcome == vector["outcome"]
    assert decompress_payload(escaped).payload == raw


@pytest.mark.parametrize("vector", vectors("compressedDecodeVectors"))
def test_compressed_decode(vector):
    raw = bytes.fromhex(vector["inputHex"])
    if "codecFixture" in vector:
        fixture = vector["codecFixture"]
        if fixture["succeeds"]:
            assert zstandard.ZstdDecompressor().decompress(raw[1:]).hex() == fixture["decodedHex"]
        else:
            with pytest.raises(zstandard.ZstdError):
                zstandard.ZstdDecompressor().decompress(raw[1:])
    result = decompress_payload(raw, vector.get("maxDecompressedBytes", 536870912))
    assert result.payload == payload(vector)
    assert result.outcome == vector.get("outcome", "decompressed")


@pytest.mark.parametrize("vector", vectors("compressionWriteVectors"))
def test_compression_selection(vector):
    raw = payload(vector)
    data = raw if isinstance(raw, bytes) else utf8_bytes(raw)
    if "codecBytes" in vector:
        # zstandard's level-3 binding matches Node's codec environment for this
        # complete generated domain; establish that before comparing its model.
        native = zstandard.ZstdCompressor(level=3).compress(data)
        assert len(native) == vector["codecBytes"]["typescript"]
    result = compress_payload(
        raw, threshold_bytes=vector["thresholdBytes"], maximum=vector.get("maxDecompressedBytes", 536870912)
    )
    expected = vector.get("expectedByBinding", {}).get("typescript")
    assert result.outcome == (expected["outcome"] if expected else vector["outcome"])
    if expected:
        assert result.stored_bytes == expected["storedBytes"]
        assert result.original_bytes == vector["originalBytes"]
        escaped = escape_raw_payload(raw)
        assert (escaped if isinstance(escaped, bytes) else utf8_bytes(escaped)).hex() == vector["escapedHex"]
        if result.outcome == "compressed":
            assert result.payload[0] == expected["marker"]
    assert decompress_payload(result.payload).payload == raw


def assert_wire_vector(group, vector):
    """Completion reporters call these same real assertions before granting credit."""
    assertions = {
        "keyVectors": test_keys,
        "invalidKeyVectors": test_invalid_keys,
        "normalizeArgsVectors": test_normalize_args,
        "rampVectors": test_rollout,
        "frameVectors": test_encode,
        "invalidTimestampVectors": test_invalid_timestamp,
        "durationVectors": test_duration,
        "trackedDecodeVectors": test_tracked_decode,
        "untrackedDecodeVectors": test_untracked_decode,
        "envelopeVectors": test_envelopes,
        "compressedDecodeVectors": test_compressed_decode,
        "compressionWriteVectors": test_compression_selection,
    }
    try:
        assertion = assertions[group]
    except KeyError:
        raise ValueError(f"Unsupported wire vector group: {group}") from None
    assertion(vector)
