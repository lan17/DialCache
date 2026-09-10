# Portable text decoding and invalidation states

These rules supplement the [wire protocol reference](../docs/redis.md#advanced-wire-protocol)
and the W01–W09 obligations in [CONTRACTS.md](./CONTRACTS.md). They define
interoperability behavior independently of a host language's string or Redis API.
The protocol vectors test these rules; passing the finite examples does not
replace implementing the stated input domains.

## Text payload domain

A frame's text payload, and the decompressed bytes of a `0x01` envelope, can
contain any byte sequence. Decode them as UTF-8 with U+FFFD replacement for each
maximal ill-formed subpart. Malformed UTF-8 does **not** itself produce a cache
miss or a payload-encoding error. The resulting string still passes through the
configured serializer, which may independently reject it. The unknown frame
encoding tag remains an error subject to the existing frame/fence precedence.

Use the [UTF-8 decoder](https://encoding.spec.whatwg.org/#utf-8-decoder) with
replacement error handling and **without BOM removal**. This matches the
existing TypeScript behavior. Preserve U+FEFF, Unicode noncharacters, embedded
NUL, and normalization distinctions. Do not use a fatal decoder, replace every
byte of an incomplete valid prefix separately, or merge adjacent invalid leads
into one replacement.

An equivalent byte-consumption rule is:

1. Emit ASCII directly. A leading byte in `C2..DF`, `E0..EF`, or `F0..F4`
   starts a sequence of two, three, or four bytes. Any other leading byte emits
   U+FFFD and consumes exactly that byte.
2. Continuations are `80..BF`, except the first continuation after `E0` must be
   `A0..BF`, after `ED` must be `80..9F`, after `F0` must be `90..BF`, and after
   `F4` must be `80..8F`.
3. For a complete sequence, emit its scalar. At an invalid continuation or end
   of input, emit one U+FFFD for the lead plus its accepted continuation prefix.
   Reprocess an invalid continuation as the next leading byte.

Representative outcomes are fixed by both direct-frame and compressed-text
vectors:

| Bytes | Decoded code points |
| --- | --- |
| `22 FF 22` | U+0022 U+FFFD U+0022 |
| `E2 82` | U+FFFD |
| `E2 82 41` | U+FFFD U+0041 |
| `ED A0 80` | U+FFFD U+FFFD U+FFFD |
| `F4 90 80 80` | Four U+FFFD code points |
| `EF BB BF 61` | U+FEFF U+0061 |

Binary frame payloads and decompressed `0x02` envelopes retain their exact
bytes, including bytes that are invalid UTF-8. Text decoding occurs only at a
text boundary. Invalid zstd data retains the original marked bytes with the
existing `fallback_raw` outcome; replacement text decoding applies only after
successful decompression.

## Input strings and key escaping

Text writers encode Unicode scalars as UTF-8 without normalization or a BOM
prefix. A binding exposing UTF-16 code units combines valid surrogate pairs and
replaces each unpaired surrogate with U+FFFD before encoding a **payload**.
The frame vectors include both unpaired-surrogate cases. Scalar-only host
strings can perform this conversion at their fixture/input boundary.

Key escaping has a different contract: unpaired surrogates are rejected, so a
host must not silently substitute U+FFFD and construct another key. A binding
whose string type excludes unpaired surrogates may reject them while decoding
fixture input. Valid scalar strings follow the existing UTF-8 percent-escaping
and UTF-16 ordering rules. The invalid-key vectors include these rejection
cases separately from payload conversion.

## Invalidation vector schema 2

`invalidation-vectors.json` contains a `vectors` array. Each item supplies a
unique `name`, `existing`, raw decimal argument text `futureBufferMs` and
`invalidatedAtMs`, and `expected` with optional `error` and required `state`.
Both `existing` and `expected.state` use this tagged state vocabulary:

| `kind` | Required content | `ttlMs` |
| --- | --- | --- |
| `absent` | No content fields | `-2` |
| `string` | `value`: exact string | `-1` for persistent, or positive finite TTL |
| `list` | `values`: nonempty ordered array of exact strings | `-1` for persistent, or positive finite TTL |

On success, the transition returns numeric `1` and produces the expected
string watermark and retention under the [invalidation rules](../docs/invalidation.md#watermark-lifetime).
With `error: true`, it must reject before any mutation and preserve the entire
original state: absence, type, content, list ordering, persistence, and remaining
TTL. Malformed strings and unrelated lists must remain unrepaired after invalid
arguments. Validation applies before the successful-transition repair rules.

Each of the six rejected argument classes is exercised with a valid string,
absence, malformed strings, and ordered lists; finite and persistent states
are separate cases. Adapters must inspect type before reading content when
replaying these vectors. An unconditional `GET` cannot observe preserved lists.

TTLs describe the logical transition. Real-server replay may subtract only the
server time measured around atomic fixture setup, transition, and observation.
Persistence (`-1`) and absence (`-2`) remain exact; no fixed network tolerance
is permitted. Drivers must reject unsupported schema versions. Version 2
replaces version 1's string-only `expected.watermark`/`expected.ttlMs` fields
with `expected.state`; it is intentionally incompatible.
