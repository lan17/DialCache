from __future__ import annotations

import json
import math
import os
import random
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
import zstandard

from dialcache.key import Key, normalize_args, ramp_hash, scalar_string
from dialcache.protocol import (
    Frame,
    Miss,
    RedisPayloadError,
    RedisProtocolError,
    decode_read,
    decode_tracked_read,
    decompress_payload,
    encode_frame,
    validate_invalidation_reply,
    validate_set_reply,
)
from dialcache.serializer import UNDEFINED, JsonSerializer

ROOT = Path(__file__).resolve().parents[2]

# Import the actual TypeScript module after stripping types with native Node.
# No copied key/frame algorithm and no package build is used as the oracle.
NODE_BRIDGE = r"""
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
const cache = new Map();
function moduleUrl(file) {
  if (cache.has(file)) return cache.get(file);
  let source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), {mode:'strip'});
  source = source.replace(/(from\s+["'])(\.{1,2}\/[^"']+\.js)(["'])/g, (_, before, spec, after) => {
    const resolved = path.resolve(path.dirname(file), spec.slice(0, -3) + '.ts');
    return before + moduleUrl(resolved) + after;
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  cache.set(file, url); return url;
}
let text = ''; for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
let output;
if (input.op === 'numbers') output = input.values.map(String);
else if (input.op === 'script') output = (await import(moduleUrl(path.resolve('typescript/src/internal/redis-scripts.ts')))).INVALIDATE_CACHE_SCRIPT;
else {
  const wire = await import(moduleUrl(path.resolve('typescript/src/internal/redis-payload.ts')));
  if (input.op === 'encode') output = wire.encodeRedisFrame(input.binary ? Buffer.from(input.payload,'hex') : input.payload,input.at).toString('hex');
  if (input.op === 'decode') {
    const frame = Buffer.from(input.hex,'hex');
    const result = input.tracked ? wire.decodeTrackedRedisReadResult(frame,input.watermark == null ? null : Buffer.from(input.watermark)) : wire.decodeRedisReadResult(frame);
    output = result.kind === 'miss' ? result : { at:result.createdAtMs, binary:Buffer.isBuffer(result.payload), payload:Buffer.isBuffer(result.payload)?result.payload.toString('hex'):result.payload };
  }
}
process.stdout.write(JSON.stringify(output));
"""


def node_bridge(message):
    node = os.environ.get("NODE", shutil.which("node"))
    if node is None:
        pytest.fail("Node 24+ is required for native cross-language conformance")
    result = subprocess.run(
        [node, "--input-type=module", "-e", NODE_BRIDGE],
        cwd=ROOT,
        input=json.dumps(message),
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_native_ieee754_scalar_identity_matches_javascript():
    values = [
        0.0,
        -0.0,
        1e-7,
        1e-6,
        1e20,
        1e21,
        1e23,
        1.0000000000000001e18,
        9007199254740992.0,
        1000000000000000100.0,
        5e-324,
        float.fromhex("0x1.fffffffffffffp+1023"),
    ]
    for value in list(values):
        values.extend(
            candidate
            for candidate in [math.nextafter(value, -math.inf), math.nextafter(value, math.inf)]
            if math.isfinite(candidate)
        )
    generator = random.Random(31001)
    while len(values) < 10000:
        value = struct.unpack(">d", generator.randbytes(8))[0]
        if math.isfinite(value):
            values.append(value)
    assert [scalar_string(value) for value in values] == node_bridge({"op": "numbers", "values": values})


def test_arbitrary_bigints_and_scalar_domains():
    assert scalar_string(10**5000 + 7) == "1" + "0" * 4999 + "7"
    assert scalar_string(-(10**5000 + 7)) == "-1" + "0" * 4999 + "7"
    assert scalar_string(-0.0) == "0"
    assert scalar_string(math.nan) == "NaN"
    assert scalar_string(math.inf) == "Infinity"
    assert scalar_string(-math.inf) == "-Infinity"
    with pytest.raises(TypeError):
        scalar_string([])


def test_utf16_order_pairs_and_payload_surrogates():
    assert normalize_args({"\ue000": 1, "\U00010000": 2, "missing": UNDEFINED}) == (
        ("\U00010000", "2"),
        ("\ue000", "1"),
    )
    pair_key = Key("urn", "id", "\ud83d\ude00", "Get")
    assert pair_key.logical == Key("urn", "id", "😀", "Get").logical
    assert encode_frame("\ud83d\ude00", 1) == encode_frame("😀", 1)
    assert encode_frame("\ud800", 1)[10:] == b"\xef\xbf\xbd"
    assert ramp_hash("😀", "local") == ramp_hash("\ud83d\ude00", "local")


@pytest.mark.parametrize("raw", ["text", bytearray(b"frame"), memoryview(b"frame"), 1, False, [], {}])
def test_protocol_rejects_nonbulk_runtime_replies(raw):
    with pytest.raises(RedisPayloadError):
        decode_read(raw)
    with pytest.raises(RedisPayloadError):
        decode_tracked_read(None, raw)


def test_fence_grammar_and_classification_precedence():
    frame = encode_frame("x", 1)
    assert decode_tracked_read(None, b"bad") == Miss("value_absent")
    assert decode_tracked_read(frame, b"0" * 10000) == Frame(1, "x")
    assert decode_tracked_read(frame, b"9" * 10000) == Miss("unclassified")
    assert decode_tracked_read(frame[:9] + b"\xffx", b"1") == Miss("watermark_fenced", 1)
    with pytest.raises(ValueError):
        encode_frame("x", 10**5000)


def test_mutation_replies_are_strict():
    for reply in [None, False, "1", b"1", 1.0, True, 0, 2]:
        with pytest.raises(RedisProtocolError):
            validate_invalidation_reply(reply)
    validate_invalidation_reply(1)
    for reply in [None, False, "ok", 1, b"no"]:
        with pytest.raises(RedisProtocolError):
            validate_set_reply(reply)
    for reply in ["OK", b"OK", True]:
        validate_set_reply(reply)


def test_compression_resource_and_native_stream_boundaries():
    for known_size in [True, False]:
        compressed = zstandard.ZstdCompressor(write_content_size=known_size).compress(b"a" * 10000)
        raw = b"\x02" + compressed
        assert decompress_payload(raw, 9999).outcome == "read_over_limit"
        assert decompress_payload(raw, 10000).payload == b"a" * 10000
        assert decompress_payload(raw[:-1], 10000).outcome == "fallback_raw"
        assert decompress_payload(raw[:-1], 2).outcome == "fallback_raw"
    first = zstandard.ZstdCompressor().compress(b"first")
    second = zstandard.ZstdCompressor().compress(b"second")
    # Match Node's native decoder: only the first completed stream is consumed.
    assert decompress_payload(b"\x01" + first + second).payload == "first"
    assert decompress_payload(b"\x01" + first + b"trailer").payload == "first"


def test_json_roundtrips_and_undefined():
    serializer = JsonSerializer()
    values = [None, False, True, 0, -42, 1.5, "雪", {"k": [1, None, "x"]}, UNDEFINED]
    for value in values:
        assert serializer.load(serializer.dump(value)) == value
    assert serializer.dump(UNDEFINED) == "__dialcache_json_undefined_v1__"
    assert serializer.load('"__dialcache_json_undefined_v1__"') == "__dialcache_json_undefined_v1__"
    assert serializer.load(b'"\xff"') == "\ufffd"
    for value in [math.nan, math.inf, -math.inf, object()]:
        with pytest.raises((TypeError, ValueError)):
            serializer.dump(value)


@pytest.mark.parametrize("value", ["\ud800", "\udc00", "A\ud800B", {"\ud800": ["\udc00", "雪"]}])
def test_json_strings_survive_the_frame_utf8_boundary(value):
    serializer = JsonSerializer()
    decoded = decode_read(encode_frame(serializer.dump(value), 1))
    assert isinstance(decoded, Frame)
    assert serializer.load(decoded.payload) == value


@pytest.mark.parametrize("size", [0, 1, 65535, 65536, 65537])
@pytest.mark.parametrize("trailer", [b"garbage", zstandard.ZstdCompressor().compress(b"second" * 1000)])
def test_unknown_size_decoder_stops_at_first_frame(size, trailer):
    raw = b"a" * size
    first = zstandard.ZstdCompressor(write_content_size=False).compress(raw)
    result = decompress_payload(b"\x02" + first + trailer, maximum=size)
    assert result.outcome == "decompressed"
    assert result.payload == raw
    assert decompress_payload(b"\x02" + first[:-1], maximum=size).outcome == "fallback_raw"


@pytest.mark.parametrize("known_size", [False, True])
def test_bad_checksum_preserves_output_limit_precedence(known_size):
    encoded = zstandard.ZstdCompressor(write_content_size=known_size, write_checksum=True).compress(
        b"a" * 100000
    )
    bad = b"\x02" + encoded[:-1] + bytes([encoded[-1] ^ 1])
    assert decompress_payload(bad, maximum=65536).outcome == "read_over_limit"
    assert decompress_payload(bad).outcome == "fallback_raw"


@pytest.mark.parametrize("corrupt", [False, True])
def test_unknown_size_decode_allocates_for_output_instead_of_ceiling(corrupt):
    import tracemalloc

    raw = b"a" * 10000
    encoded = zstandard.ZstdCompressor(write_content_size=False, write_checksum=True).compress(raw)
    if corrupt:
        encoded = encoded[:-1] + bytes([encoded[-1] ^ 1])
    payload = b"\x02" + encoded
    tracemalloc.start()
    try:
        result = decompress_payload(payload)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result.outcome == ("fallback_raw" if corrupt else "decompressed")
    assert result.payload == (payload if corrupt else raw)
    # This small output used to allocate the 512 MiB decompression ceiling.
    # Keep generous headroom for interpreter/dependency allocation differences.
    assert peak < 8 * 1024 * 1024


def test_known_oversized_decode_does_not_retain_unusable_output():
    import tracemalloc

    maximum = 8 * 1024 * 1024
    payload = b"\x02" + zstandard.ZstdCompressor().compress(b"a" * (maximum + 1))
    tracemalloc.start()
    try:
        result = decompress_payload(payload, maximum)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result.outcome == "read_over_limit"
    assert result.payload is payload
    # The frame header already rules out returning decoded bytes. Classification
    # must use bounded chunks rather than retaining approximately the full cap.
    assert peak < 2 * 1024 * 1024
