import { describe, expect, it, vi } from "vitest";

import {
  SHADOW_LOG_KEY_MAX_BYTES,
  SHADOW_LOG_TRUNCATION_MARKER,
  SHADOW_LOG_VALUE_MAX_BYTES,
  diffShadowMismatchJson,
  previewShadowLogKey,
  renderShadowMismatchLog,
  type JsonValue,
  type ShadowMismatchJsonEntry,
  type ShadowMismatchLogPlan,
} from "../src/internal/shadow-log-json.js";

const VALUE_ONLY: ShadowMismatchLogPlan = { value: true, diff: "off" };
const PATHS_ONLY: ShadowMismatchLogPlan = { value: false, diff: "paths" };
const VALUES_ONLY: ShadowMismatchLogPlan = { value: false, diff: "values" };
const EVERYTHING: ShadowMismatchLogPlan = { value: true, diff: "values" };

interface MismatchPathVector {
  readonly name: string;
  readonly cached: JsonValue;
  readonly source: JsonValue;
  readonly entries: readonly ShadowMismatchJsonEntry[];
  readonly count: number;
}

// Hand-authored expectations for the built-in differ, written as JSON so the
// group can move unchanged into formal/catalogs/protocol-vectors.json. The
// depth vectors nest arrays in groups of eight; each "/0" is one token.
const MISMATCH_PATH_VECTORS: readonly MismatchPathVector[] = [
  {
    "name": "identical objects",
    "cached": {"id": "123", "tags": ["a", "b"], "meta": {}, "list": [], "profile": {"email": "a@example.com"}},
    "source": {"id": "123", "tags": ["a", "b"], "meta": {}, "list": [], "profile": {"email": "a@example.com"}},
    "entries": [],
    "count": 0
  },
  {
    "name": "identical primitives",
    "cached": "same",
    "source": "same",
    "entries": [],
    "count": 0
  },
  {
    "name": "identical objects with different member order",
    "cached": {"a": 1, "b": {"c": 2, "d": 3}},
    "source": {"b": {"d": 3, "c": 2}, "a": 1},
    "entries": [],
    "count": 0
  },
  {
    "name": "differing number roots",
    "cached": 1,
    "source": 2,
    "entries": [{"path": "", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "differing string roots",
    "cached": "old",
    "source": "new",
    "entries": [{"path": "", "cached": "old", "source": "new"}],
    "count": 1
  },
  {
    "name": "null root against false root",
    "cached": null,
    "source": false,
    "entries": [{"path": "", "cached": null, "source": false}],
    "count": 1
  },
  {
    "name": "number root against string root",
    "cached": 1,
    "source": "1",
    "entries": [{"path": "", "cached": 1, "source": "1"}],
    "count": 1
  },
  {
    "name": "object root against array root",
    "cached": {},
    "source": [],
    "entries": [{"path": "", "cached": {}, "source": []}],
    "count": 1
  },
  {
    "name": "array root against string root",
    "cached": ["a"],
    "source": "a",
    "entries": [{"path": "", "cached": ["a"], "source": "a"}],
    "count": 1
  },
  {
    "name": "null root against object root",
    "cached": null,
    "source": {"a": null},
    "entries": [{"path": "", "cached": null, "source": {"a": null}}],
    "count": 1
  },
  {
    "name": "nested member change",
    "cached": {"id": "123", "profile": {"email": "old@example.com", "name": "Ada"}},
    "source": {"id": "123", "profile": {"email": "new@example.com", "name": "Ada"}},
    "entries": [{"path": "/profile/email", "cached": "old@example.com", "source": "new@example.com"}],
    "count": 1
  },
  {
    "name": "nested members changing kind",
    "cached": {"a": [1], "b": {"c": 1}, "d": null},
    "source": {"a": {"0": 1}, "b": "c", "d": {}},
    "entries": [
      {"path": "/a", "cached": [1], "source": {"0": 1}},
      {"path": "/b", "cached": {"c": 1}, "source": "c"},
      {"path": "/d", "cached": null, "source": {}}
    ],
    "count": 3
  },
  {
    "name": "member only in cached",
    "cached": {"id": 1, "legacy": {"flag": true}},
    "source": {"id": 1},
    "entries": [{"path": "/legacy", "cached": {"flag": true}}],
    "count": 1
  },
  {
    "name": "member only in source",
    "cached": {"id": 1},
    "source": {"id": 1, "roles": ["admin"]},
    "entries": [{"path": "/roles", "source": ["admin"]}],
    "count": 1
  },
  {
    "name": "one-sided members on both sides",
    "cached": {"a": 1, "b": 2},
    "source": {"b": 2, "c": 3},
    "entries": [{"path": "/a", "cached": 1}, {"path": "/c", "source": 3}],
    "count": 2
  },
  {
    "name": "one-sided null member",
    "cached": {"a": null},
    "source": {},
    "entries": [{"path": "/a", "cached": null}],
    "count": 1
  },
  {
    "name": "member names in UTF-16 code-unit order",
    "cached": {"～": 1, "b": 1, "😀": 1, "a": 1, "B": 1},
    "source": {"a": 2, "😀": 2, "B": 2, "～": 2, "b": 2},
    "entries": [
      {"path": "/B", "cached": 1, "source": 2},
      {"path": "/a", "cached": 1, "source": 2},
      {"path": "/b", "cached": 1, "source": 2},
      {"path": "/😀", "cached": 1, "source": 2},
      {"path": "/～", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "integer-like member names in string order",
    "cached": {"9": 1, "10": 1, "a": 1},
    "source": {"9": 2, "10": 2, "a": 2},
    "entries": [
      {"path": "/10", "cached": 1, "source": 2},
      {"path": "/9", "cached": 1, "source": 2},
      {"path": "/a", "cached": 1, "source": 2}
    ],
    "count": 3
  },
  {
    "name": "equal-length arrays recursed by index",
    "cached": {"items": [1, 2, 3]},
    "source": {"items": [1, 5, 4]},
    "entries": [
      {"path": "/items/1", "cached": 2, "source": 5},
      {"path": "/items/2", "cached": 3, "source": 4}
    ],
    "count": 2
  },
  {
    "name": "equal-length arrays of objects recursed into each item",
    "cached": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}],
    "source": [{"id": 1, "name": "a"}, {"id": 2, "name": "c"}],
    "entries": [{"path": "/1/name", "cached": "b", "source": "c"}],
    "count": 1
  },
  {
    "name": "different-length root arrays reported once",
    "cached": [1, 2],
    "source": [1, 2, 3],
    "entries": [{"path": "", "cached": [1, 2], "source": [1, 2, 3]}],
    "count": 1
  },
  {
    "name": "different-length nested arrays reported once at the array pointer",
    "cached": {"name": "x", "roles": ["admin"], "tags": []},
    "source": {"name": "y", "roles": ["admin", "owner"], "tags": [null]},
    "entries": [
      {"path": "/name", "cached": "x", "source": "y"},
      {"path": "/roles", "cached": ["admin"], "source": ["admin", "owner"]},
      {"path": "/tags", "cached": [], "source": [null]}
    ],
    "count": 3
  },
  {
    "name": "escaped reference tokens and the empty member name",
    "cached": {"m~n": 1, "a/b": 1, "/": 1, "~1": 1, "": 1},
    "source": {"": 2, "~1": 2, "/": 2, "a/b": 2, "m~n": 2},
    "entries": [
      {"path": "/", "cached": 1, "source": 2},
      {"path": "/~1", "cached": 1, "source": 2},
      {"path": "/a~1b", "cached": 1, "source": 2},
      {"path": "/m~0n", "cached": 1, "source": 2},
      {"path": "/~01", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "nested empty member names",
    "cached": {"": {"": "x"}},
    "source": {"": {"": "y"}},
    "entries": [{"path": "//", "cached": "x", "source": "y"}],
    "count": 1
  },
  {
    "name": "escaped tokens composed with array indices",
    "cached": {"a/b": [0, {"~": 1}]},
    "source": {"a/b": [0, {"~": 2}]},
    "entries": [{"path": "/a~1b/1/~0", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "entries in walk order",
    "cached": {"z": [1, {"b": 1, "a": 1}], "a": {"y": 1, "x": 1}},
    "source": {"a": {"x": 2, "y": 2}, "z": [2, {"a": 2, "b": 2}]},
    "entries": [
      {"path": "/a/x", "cached": 1, "source": 2},
      {"path": "/a/y", "cached": 1, "source": 2},
      {"path": "/z/0", "cached": 1, "source": 2},
      {"path": "/z/1/a", "cached": 1, "source": 2},
      {"path": "/z/1/b", "cached": 1, "source": 2}
    ],
    "count": 5
  },
  {
    "name": "difference at the depth cap reported at its own pointer",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ 1 ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ 2 ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [{"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0", "cached": 1, "source": 2}],
    "count": 1
  },
  {
    "name": "difference past the depth cap reported at the 32-token container",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ [1] ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ [2] ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [{"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0", "cached": [1], "source": [2]}],
    "count": 1
  },
  {
    "name": "equal containers past the depth cap with different member order",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ {"a": 1, "b": {"c": [1, 2], "d": null}} ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[[ {"b": {"d": null, "c": [1, 2]}, "a": 1} ]]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [],
    "count": 0
  },
  {
    "name": "containers at the depth cap reported whole",
    "cached": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[ {
      "kinds": {"m": [1]},
      "kindsSwap": {"m": {"0": 1}},
      "lengths": [[1, 2]],
      "lengthsShort": [[1]],
      "members": {"k": 1},
      "order": {"x": 1, "y": {"p": null, "q": [true]}},
      "sizes": {"a": 1},
      "values": [1]
    } ]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "source": [[[[[[[[ [[[[[[[[ [[[[[[[[ [[[[[[[ {
      "values": [2],
      "sizes": {"a": 1, "b": 2},
      "order": {"y": {"q": [true], "p": null}, "x": 1},
      "members": {"j": 1},
      "lengthsShort": [[1, 2]],
      "lengths": [[1]],
      "kindsSwap": {"m": [1]},
      "kinds": {"m": {"0": 1}}
    } ]]]]]]] ]]]]]]]] ]]]]]]]] ]]]]]]]],
    "entries": [
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/kinds", "cached": {"m": [1]}, "source": {"m": {"0": 1}}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/kindsSwap", "cached": {"m": {"0": 1}}, "source": {"m": [1]}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/lengths", "cached": [[1, 2]], "source": [[1]]},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/lengthsShort", "cached": [[1]], "source": [[1, 2]]},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/members", "cached": {"k": 1}, "source": {"j": 1}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/sizes", "cached": {"a": 1}, "source": {"a": 1, "b": 2}},
      {"path": "/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/values", "cached": [1], "source": [2]}
    ],
    "count": 7
  },
  {
    "name": "documented example: a user record at four differing fields",
    "cached": {"id": "u_123", "email": "ana@example.com", "plan": "free", "roles": ["viewer"], "profile": {"name": "Ana", "locale": "en-US"}},
    "source": {"id": "u_123", "email": "ana@example.com", "plan": "pro", "roles": ["viewer", "editor"], "profile": {"name": "Ana", "locale": "en-GB", "timezone": "Europe/London"}},
    "entries": [
      {"path": "/plan", "cached": "free", "source": "pro"},
      {"path": "/profile/locale", "cached": "en-US", "source": "en-GB"},
      {"path": "/profile/timezone", "source": "Europe/London"},
      {"path": "/roles", "cached": ["viewer"], "source": ["viewer", "editor"]}
    ],
    "count": 4
  },
  {
    "name": "documented example: a changed field",
    "cached": {"plan": "free"},
    "source": {"plan": "pro"},
    "entries": [{"path": "/plan", "cached": "free", "source": "pro"}],
    "count": 1
  },
  {
    "name": "documented example: an element changed in place",
    "cached": {"tags": ["a", "b"]},
    "source": {"tags": ["a", "c"]},
    "entries": [{"path": "/tags/1", "cached": "b", "source": "c"}],
    "count": 1
  },
  {
    "name": "documented example: an element inserted",
    "cached": {"tags": ["a", "b"]},
    "source": {"tags": ["a", "x", "b"]},
    "entries": [{"path": "/tags", "cached": ["a", "b"], "source": ["a", "x", "b"]}],
    "count": 1
  },
  {
    "name": "documented example: a field only the source has",
    "cached": {"name": "Ana"},
    "source": {"name": "Ana", "nickname": "A"},
    "entries": [{"path": "/nickname", "source": "A"}],
    "count": 1
  },
  {
    "name": "documented example: a field only the cache has",
    "cached": {"name": "Ana", "nickname": "A"},
    "source": {"name": "Ana"},
    "entries": [{"path": "/nickname", "cached": "A"}],
    "count": 1
  },
  {
    "name": "documented example: a field changing type",
    "cached": {"count": 1},
    "source": {"count": "1"},
    "entries": [{"path": "/count", "cached": 1, "source": "1"}],
    "count": 1
  },
  {
    "name": "documented example: an object replaced by null",
    "cached": {"address": {"city": "Paris"}},
    "source": {"address": null},
    "entries": [{"path": "/address", "cached": {"city": "Paris"}, "source": null}],
    "count": 1
  },
  {
    "name": "documented example: member names with escaped characters",
    "cached": {"a/b": 1, "m~n": 1},
    "source": {"a/b": 2, "m~n": 2},
    "entries": [
      {"path": "/a~1b", "cached": 1, "source": 2},
      {"path": "/m~0n", "cached": 1, "source": 2}
    ],
    "count": 2
  },
  {
    "name": "documented example: roots of different kinds",
    "cached": ["a", "b"],
    "source": {"items": ["a", "b"]},
    "entries": [{"path": "", "cached": ["a", "b"], "source": {"items": ["a", "b"]}}],
    "count": 1
  }
];

const CACHED_USER = { id: "123", email: "old@example.com" };
const SOURCE_USER = { id: "123", email: "new@example.com" };
const CACHED_USER_JSON = '{"id":"123","email":"old@example.com"}';
const SOURCE_USER_JSON = '{"id":"123","email":"new@example.com"}';
const FAILED_DIFF = { mismatchPaths: null, mismatchPathCount: null, diffJson: null } as const;

function circular(): unknown {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}

function nestMembers(depth: number, leaf: JsonValue): JsonValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = { n: value };
  }
  return value;
}

describe("shadow mismatch log JSON", () => {
  it("uses native JSON for the values supplied to the comparator", () => {
    expect(previewShadowLogKey("urn:user_id:123#GetUser")).toBe("urn:user_id:123#GetUser");
    expect(renderShadowMismatchLog(
      VALUE_ONLY,
      { id: "123", updatedAt: new Date("2026-07-31T00:00:00.000Z") },
      { id: "123", updatedAt: new Date("2026-08-01T00:00:00.000Z") },
    )).toStrictEqual({
      fields: {
        cachedValueJson: '{"id":"123","updatedAt":"2026-07-31T00:00:00.000Z"}',
        sourceValueJson: '{"id":"123","updatedAt":"2026-08-01T00:00:00.000Z"}',
      },
      failure: null,
    });
  });

  it("returns null independently for values that native JSON cannot serialize", () => {
    expect(renderShadowMismatchLog(VALUE_ONLY, circular(), { version: 2 })).toStrictEqual({
      fields: { cachedValueJson: null, sourceValueJson: '{"version":2}' },
      failure: "render_error",
    });
    expect(renderShadowMismatchLog(VALUE_ONLY, 1n, undefined)).toStrictEqual({
      fields: { cachedValueJson: null, sourceValueJson: null },
      failure: "render_error",
    });
  });

  it("catches user JSON hook failures", () => {
    const value = {
      toJSON(): never {
        throw new Error("not serializable");
      },
    };

    expect(renderShadowMismatchLog(VALUE_ONLY, value, { version: 2 })).toStrictEqual({
      fields: { cachedValueJson: null, sourceValueJson: '{"version":2}' },
      failure: "render_error",
    });
  });

  it("byte-clamps keys and JSON without splitting UTF-8 sequences", () => {
    const key = `${"k".repeat(SHADOW_LOG_KEY_MAX_BYTES)}🙂`;
    const value = { text: "🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES) };
    const keyPreview = previewShadowLogKey(key);
    const { fields } = renderShadowMismatchLog(VALUE_ONLY, value, value);
    const valuePreview = fields.cachedValueJson;

    expect(typeof valuePreview).toBe("string");
    expect(Buffer.byteLength(keyPreview)).toBeLessThanOrEqual(SHADOW_LOG_KEY_MAX_BYTES);
    expect(Buffer.byteLength(valuePreview!)).toBeLessThanOrEqual(SHADOW_LOG_VALUE_MAX_BYTES);
    expect(keyPreview.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(valuePreview!.endsWith(SHADOW_LOG_TRUNCATION_MARKER)).toBe(true);
    expect(keyPreview).not.toContain("�");
    expect(valuePreview).not.toContain("�");
    expect(fields.sourceValueJson).toBe(valuePreview);
  });

  describe("built-in mismatch paths", () => {
    it.each(MISMATCH_PATH_VECTORS)("computes the expected entries for $name", ({ cached, source, entries, count }) => {
      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({ entries, count });
    });

    it.each(MISMATCH_PATH_VECTORS)("renders the expected diff fields for $name", ({ cached, source, entries, count }) => {
      const { fields, failure } = renderShadowMismatchLog(VALUES_ONLY, cached, source);

      expect(failure).toBeNull();
      expect(fields.mismatchPaths).toStrictEqual(entries.map((entry) => entry.path));
      expect(fields.mismatchPathCount).toBe(count);
      expect(JSON.parse(fields.diffJson!)).toStrictEqual(entries);
      expect(renderShadowMismatchLog(PATHS_ONLY, cached, source)).toStrictEqual({
        fields: { mismatchPaths: fields.mismatchPaths, mismatchPathCount: count },
        failure: null,
      });
    });

    it("walks own members whose names collide with Object.prototype", () => {
      // Parsed rather than written as literals: a "__proto__" key in an object
      // literal sets the prototype instead of creating a member.
      const cached = JSON.parse('{"constructor":1,"__proto__":{"a":1}}') as JsonValue;
      const source = JSON.parse('{"toString":"x","valueOf":null,"__proto__":{"a":2}}') as JsonValue;
      const entries = [
        { path: "/__proto__/a", cached: 1, source: 2 },
        { path: "/constructor", cached: 1 },
        { path: "/toString", source: "x" },
        { path: "/valueOf", source: null },
      ];

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({ entries, count: 4 });
      const { fields, failure } = renderShadowMismatchLog(VALUES_ONLY, cached, source);
      expect(failure).toBeNull();
      expect(fields.mismatchPaths).toStrictEqual(entries.map((entry) => entry.path));
      expect(JSON.parse(fields.diffJson!)).toStrictEqual(entries);
    });

    it("compares only own members in a depth-capped pair", () => {
      const nest = (leaf: string): JsonValue => JSON.parse(`${'{"a":'.repeat(32)}${leaf}${"}".repeat(32)}`) as JsonValue;
      const cached = nest('{"__proto__":{}}');
      const source = nest('{"b":{}}');
      const entries = [{ path: "/a".repeat(32), cached: JSON.parse('{"__proto__":{}}') as JsonValue, source: { b: {} } }];

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({ entries, count: 1 });
      const { fields, failure } = renderShadowMismatchLog(VALUES_ONLY, cached, source);
      expect(failure).toBeNull();
      expect(fields.mismatchPaths).toStrictEqual(["/a".repeat(32)]);
      expect(JSON.parse(fields.diffJson!)).toStrictEqual(JSON.parse(JSON.stringify(entries)));
    });

    it("cuts the entries at 64 in walk order and counts every difference", () => {
      const cached: Record<string, JsonValue> = {};
      const source: Record<string, JsonValue> = {};
      for (let index = 69; index >= 0; index -= 1) {
        cached[`m${String(index).padStart(2, "0")}`] = 0;
        source[`m${String(index).padStart(2, "0")}`] = 1;
      }
      const entries = Array.from({ length: 64 }, (_, index) => ({
        path: `/m${String(index).padStart(2, "0")}`,
        cached: 0,
        source: 1,
      }));

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({ entries, count: 70 });
      expect(renderShadowMismatchLog(PATHS_ONLY, cached, source)).toStrictEqual({
        fields: { mismatchPaths: entries.map((entry) => entry.path), mismatchPathCount: 70 },
        failure: null,
      });
    });

    it("clamps each pointer to 512 bytes without splitting UTF-8 sequences", () => {
      const cached = { ["k".repeat(511)]: 1, ["k".repeat(600)]: 1, ["é".repeat(300)]: 1 };
      const source = { ["k".repeat(511)]: 2, ["k".repeat(600)]: 2, ["é".repeat(300)]: 2 };

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({
        entries: [
          { path: `/${"k".repeat(511)}`, cached: 1, source: 2 },
          { path: `/${"k".repeat(497)}${SHADOW_LOG_TRUNCATION_MARKER}`, cached: 1, source: 2 },
          { path: `/${"é".repeat(248)}${SHADOW_LOG_TRUNCATION_MARKER}`, cached: 1, source: 2 },
        ],
        count: 3,
      });
    });

    it("replaces each side over 1 KiB with its clamped JSON text", () => {
      const list = Array.from({ length: 300 }, () => 1000);
      const cached = {
        accent: "é".repeat(600),
        blob: "x".repeat(2000),
        edge: "e".repeat(1022),
        extra: "z".repeat(1100),
        list,
      };
      const source = { accent: "a", blob: "y", edge: "f".repeat(1022), list: [1000] };

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({
        entries: [
          { path: "/accent", cached: `"${"é".repeat(504)}${SHADOW_LOG_TRUNCATION_MARKER}`, source: "a" },
          { path: "/blob", cached: `"${"x".repeat(1009)}${SHADOW_LOG_TRUNCATION_MARKER}`, source: "y" },
          { path: "/edge", cached: "e".repeat(1022), source: "f".repeat(1022) },
          { path: "/extra", cached: `"${"z".repeat(1009)}${SHADOW_LOG_TRUNCATION_MARKER}` },
          { path: "/list", cached: `${JSON.stringify(list).slice(0, 1010)}${SHADOW_LOG_TRUNCATION_MARKER}`, source: [1000] },
        ],
        count: 5,
      });
    });

    it("caps the walk at 32 reference tokens however deep the difference lies", () => {
      expect(diffShadowMismatchJson(nestMembers(40, 1), nestMembers(40, 2))).toStrictEqual({
        entries: [{ path: "/n".repeat(32), cached: nestMembers(8, 1), source: nestMembers(8, 2) }],
        count: 1,
      });
      const clampedSide = `${'{"n":'.repeat(202)}${SHADOW_LOG_TRUNCATION_MARKER}`;
      expect(diffShadowMismatchJson(nestMembers(1000, 1), nestMembers(1000, 2))).toStrictEqual({
        entries: [{ path: "/n".repeat(32), cached: clampedSide, source: clampedSide }],
        count: 1,
      });
    });

    it("compares equal containers past the depth cap regardless of member order and depth", () => {
      let cached: JsonValue = "leaf";
      let source: JsonValue = "leaf";
      for (let level = 0; level < 100_000; level += 1) {
        cached = { a: level, next: cached };
        source = { next: source, a: level };
      }

      expect(diffShadowMismatchJson(cached, source)).toStrictEqual({ entries: [], count: 0 });
    });
  });

  describe("mismatch log rendering", () => {
    it.each([
      ["neither leaf", { value: false, diff: "off" }, {}],
      ["diff paths only", PATHS_ONLY, { mismatchPaths: ["/email"], mismatchPathCount: 1 }],
      ["diff values without value", VALUES_ONLY, {
        mismatchPaths: ["/email"],
        mismatchPathCount: 1,
        diffJson: '[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]',
      }],
      ["value only", VALUE_ONLY, { cachedValueJson: CACHED_USER_JSON, sourceValueJson: SOURCE_USER_JSON }],
      ["value with diff paths", { value: true, diff: "paths" }, {
        mismatchPaths: ["/email"],
        mismatchPathCount: 1,
        cachedValueJson: CACHED_USER_JSON,
        sourceValueJson: SOURCE_USER_JSON,
      }],
      ["value with diff values", EVERYTHING, {
        mismatchPaths: ["/email"],
        mismatchPathCount: 1,
        diffJson: '[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]',
        cachedValueJson: CACHED_USER_JSON,
        sourceValueJson: SOURCE_USER_JSON,
      }],
    ] as const)("renders exactly the fields requested by %s", (_name, plan, fields) => {
      const content = renderShadowMismatchLog(plan, CACHED_USER, SOURCE_USER);

      expect(content).toStrictEqual({ fields, failure: null });
      expect(Object.keys(content.fields)).toStrictEqual(Object.keys(fields));
    });

    it("renders no entries for byte-identical renderings", () => {
      const noEntries = { mismatchPaths: [], mismatchPathCount: 0, diffJson: "[]" };

      expect(renderShadowMismatchLog(EVERYTHING, { id: 1, dropped: undefined }, { id: 1 })).toStrictEqual({
        fields: { ...noEntries, cachedValueJson: '{"id":1}', sourceValueJson: '{"id":1}' },
        failure: null,
      });
      expect(renderShadowMismatchLog(VALUES_ONLY, new Map([["a", 1]]), {})).toStrictEqual({
        fields: noEntries,
        failure: null,
      });
    });

    it("renders no entries for the documented Date row", () => {
      // docs/shadow-validation.md: the JSON serializer stored the Date as this
      // string, and the source returns the Date itself.
      expect(renderShadowMismatchLog(
        VALUES_ONLY,
        { at: "2026-10-24T00:00:00.000Z" },
        { at: new Date("2026-10-24T00:00:00.000Z") },
      )).toStrictEqual({
        fields: { mismatchPaths: [], mismatchPathCount: 0, diffJson: "[]" },
        failure: null,
      });
    });

    it("reports the source whole at the root for the documented undefined row", () => {
      // docs/shadow-validation.md: a cached negative-cache entry against a value.
      expect(renderShadowMismatchLog(EVERYTHING, undefined, { plan: "pro" })).toStrictEqual({
        fields: {
          mismatchPaths: [""],
          mismatchPathCount: 1,
          diffJson: '[{"path":"","source":{"plan":"pro"}}]',
          cachedValueJson: null,
          sourceValueJson: '{"plan":"pro"}',
        },
        failure: null,
      });
    });

    it("renders no entries for a Date against its ISO string", () => {
      expect(renderShadowMismatchLog(
        VALUES_ONLY,
        { updatedAt: new Date("2026-07-31T00:00:00.000Z") },
        { updatedAt: "2026-07-31T00:00:00.000Z" },
      )).toStrictEqual({
        fields: { mismatchPaths: [], mismatchPathCount: 0, diffJson: "[]" },
        failure: null,
      });
    });

    it.each([
      ["cycle", circular()],
      ["bigint", 1n],
      ["throwing toJSON", { toJSON: (): never => { throw new Error("not serializable"); } }],
      ["function", () => 1],
      ["symbol", Symbol("value")],
    ])("nulls the fields fed by a root %s with render_error", (_name, unrenderable) => {
      expect(renderShadowMismatchLog(EVERYTHING, unrenderable, { version: 2 })).toStrictEqual({
        fields: { ...FAILED_DIFF, cachedValueJson: null, sourceValueJson: '{"version":2}' },
        failure: "render_error",
      });
      expect(renderShadowMismatchLog(EVERYTHING, { version: 2 }, unrenderable)).toStrictEqual({
        fields: { ...FAILED_DIFF, cachedValueJson: '{"version":2}', sourceValueJson: null },
        failure: "render_error",
      });
      expect(renderShadowMismatchLog(PATHS_ONLY, { version: 2 }, unrenderable)).toStrictEqual({
        fields: { mismatchPaths: null, mismatchPathCount: null },
        failure: "render_error",
      });
    });

    it("reports an absent root as one side at the root pointer, not as a render failure", () => {
      expect(renderShadowMismatchLog(EVERYTHING, undefined, { version: 2 })).toStrictEqual({
        fields: {
          mismatchPaths: [""],
          mismatchPathCount: 1,
          diffJson: '[{"path":"","source":{"version":2}}]',
          cachedValueJson: null,
          sourceValueJson: '{"version":2}',
        },
        failure: null,
      });
      expect(renderShadowMismatchLog(EVERYTHING, { version: 2 }, undefined)).toStrictEqual({
        fields: {
          mismatchPaths: [""],
          mismatchPathCount: 1,
          diffJson: '[{"path":"","cached":{"version":2}}]',
          cachedValueJson: '{"version":2}',
          sourceValueJson: null,
        },
        failure: null,
      });
      expect(renderShadowMismatchLog(PATHS_ONLY, undefined, null)).toStrictEqual({
        fields: { mismatchPaths: [""], mismatchPathCount: 1 },
        failure: null,
      });
      // A stored null is a value, so it stays distinct from absence.
      expect(renderShadowMismatchLog(VALUES_ONLY, undefined, null).fields.diffJson).toBe('[{"path":"","source":null}]');
      // Absence beside a side with no rendering is still a render failure.
      expect(renderShadowMismatchLog(EVERYTHING, undefined, 1n)).toStrictEqual({
        fields: { ...FAILED_DIFF, cachedValueJson: null, sourceValueJson: null },
        failure: "render_error",
      });
      // A custom comparator may call two absent values different; no field differs.
      expect(renderShadowMismatchLog(EVERYTHING, undefined, undefined)).toStrictEqual({
        fields: {
          mismatchPaths: [],
          mismatchPathCount: 0,
          diffJson: "[]",
          cachedValueJson: null,
          sourceValueJson: null,
        },
        failure: null,
      });
    });

    it("runs each side's toJSON once for every field it feeds", () => {
      let cachedRenders = 0;
      let sourceRenders = 0;
      const cached = { toJSON: vi.fn(() => ({ email: "a", render: ++cachedRenders })) };
      const source = { toJSON: vi.fn(() => ({ email: "b", render: ++sourceRenders })) };

      expect(renderShadowMismatchLog(EVERYTHING, cached, source)).toStrictEqual({
        fields: {
          mismatchPaths: ["/email"],
          mismatchPathCount: 1,
          diffJson: '[{"path":"/email","cached":"a","source":"b"}]',
          cachedValueJson: '{"email":"a","render":1}',
          sourceValueJson: '{"email":"b","render":1}',
        },
        failure: null,
      });
      expect(cached.toJSON).toHaveBeenCalledOnce();
      expect(source.toJSON).toHaveBeenCalledOnce();
    });

    it("clamps diffJson to 8 KiB with the truncation marker", () => {
      const cached: Record<string, string> = {};
      const source: Record<string, string> = {};
      const entries: ShadowMismatchJsonEntry[] = [];
      for (let index = 0; index < 20; index += 1) {
        const name = `m${String(index).padStart(2, "0")}`;
        cached[name] = "x".repeat(500);
        source[name] = "y".repeat(500);
        entries.push({ path: `/${name}`, cached: "x".repeat(500), source: "y".repeat(500) });
      }
      // The 8 KiB bound is the record's, so it is written out rather than
      // taken from the implementation's constant.
      const diffJson = `${JSON.stringify(entries).slice(0, 8192 - SHADOW_LOG_TRUNCATION_MARKER.length)}${SHADOW_LOG_TRUNCATION_MARKER}`;

      expect(renderShadowMismatchLog(VALUES_ONLY, cached, source)).toStrictEqual({
        fields: { mismatchPaths: entries.map((entry) => entry.path), mismatchPathCount: 20, diffJson },
        failure: null,
      });
      expect(Buffer.byteLength(diffJson)).toBe(8192);
    });

    it("clamps each built-in diffJson side to 1 KiB", () => {
      const { fields } = renderShadowMismatchLog(VALUES_ONLY, { blob: "x".repeat(2000) }, { blob: "y" });

      expect(JSON.parse(fields.diffJson!)).toStrictEqual([
        { path: "/blob", cached: `"${"x".repeat(1009)}${SHADOW_LOG_TRUNCATION_MARKER}`, source: "y" },
      ]);
    });

    it("fails the built-in walk closed with hook_error when it throws", () => {
      const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
        throw new Error("walk failed");
      });
      try {
        expect(renderShadowMismatchLog(EVERYTHING, CACHED_USER, SOURCE_USER)).toStrictEqual({
          fields: { ...FAILED_DIFF, cachedValueJson: CACHED_USER_JSON, sourceValueJson: SOURCE_USER_JSON },
          failure: "hook_error",
        });
        expect(renderShadowMismatchLog(PATHS_ONLY, CACHED_USER, SOURCE_USER)).toStrictEqual({
          fields: { mismatchPaths: null, mismatchPathCount: null },
          failure: "hook_error",
        });
      } finally {
        parse.mockRestore();
      }
    });
  });

  describe("mismatch diff hook", () => {
    it("takes the entries from the hook and never runs the built-in walk", () => {
      const cached = { id: 1 };
      const source = { id: 2 };
      const hook = vi.fn((_cached: unknown, _source: unknown) => [
        { path: "/profile/email", cached: "old@example.com", source: "new@example.com" },
        { path: "/roles" },
      ]);

      expect(renderShadowMismatchLog(EVERYTHING, cached, source, hook)).toStrictEqual({
        fields: {
          mismatchPaths: ["/profile/email", "/roles"],
          mismatchPathCount: 2,
          diffJson: '[{"path":"/profile/email","cached":"old@example.com","source":"new@example.com"},{"path":"/roles"}]',
          cachedValueJson: '{"id":1}',
          sourceValueJson: '{"id":2}',
        },
        failure: null,
      });
      expect(hook).toHaveBeenCalledOnce();
      expect(hook.mock.calls[0]![0]).toBe(cached);
      expect(hook.mock.calls[0]![1]).toBe(source);
    });

    it("renders neither root side when the hook supplies the entries and value is off", () => {
      const cached = { toJSON: vi.fn(() => "cached") };
      const source = { toJSON: vi.fn(() => "source") };

      expect(renderShadowMismatchLog(VALUES_ONLY, cached, source, () => [])).toStrictEqual({
        fields: { mismatchPaths: [], mismatchPathCount: 0, diffJson: "[]" },
        failure: null,
      });
      expect(cached.toJSON).not.toHaveBeenCalled();
      expect(source.toJSON).not.toHaveBeenCalled();
    });

    it.each([
      ["throws", () => {
        throw new Error("hook failed");
      }],
      ["returns a rejecting promise", () => Promise.reject(new Error("async hook"))],
      ["returns a rejecting thenable", () => ({
        then(_resolve: unknown, reject: (reason: unknown) => void): void {
          reject(new Error("thenable hook"));
        },
      })],
      ["returns a non-array object", () => ({ path: "/email" })],
      ["returns null", () => null],
      ["returns undefined", () => undefined],
      ["returns a function", () => () => []],
      ["returns a null member", () => [null]],
      ["returns a string member", () => ["/email"]],
      ["returns a function member", () => [() => "/email"]],
      ["returns a member without a path", () => [{ cached: 1 }]],
      ["returns a member with a numeric path", () => [{ path: 0 }]],
      ["returns an invalid member after a valid one", () => [{ path: "/email" }, { path: null }]],
      ["returns an invalid member past the 64-entry cut", () => [
        ...Array.from({ length: 64 }, (_, index) => ({ path: `/${index}` })),
        null,
      ]],
      ["returns a member whose side getter throws", () => [{
        path: "/email",
        get cached(): never {
          throw new Error("getter failed");
        },
      }]],
    ])("fails closed with hook_error and no fallback when the hook %s", (_name, hook) => {
      expect(renderShadowMismatchLog(EVERYTHING, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { ...FAILED_DIFF, cachedValueJson: CACHED_USER_JSON, sourceValueJson: SOURCE_USER_JSON },
        failure: "hook_error",
      });
      expect(renderShadowMismatchLog(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { mismatchPaths: null, mismatchPathCount: null },
        failure: "hook_error",
      });
    });

    it("consumes a rejecting hook result without an unhandled rejection", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        for (const hook of [
          () => Promise.reject(new Error("async hook")),
          () => ({
            then(_resolve: unknown, reject: (reason: unknown) => void): void {
              reject(new Error("thenable hook"));
            },
          }),
        ]) {
          expect(renderShadowMismatchLog(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook).failure).toBe("hook_error");
        }
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        process.off("unhandledRejection", unhandled);
      }

      expect(unhandled).not.toHaveBeenCalled();
    });

    it.each([
      ["a bigint", 1n],
      ["a cycle", circular()],
      ["a function", () => 1],
      ["a symbol", Symbol("side")],
    ])("keeps the hook paths and nulls diffJson when a hook side is %s", (_name, unrenderable) => {
      const hook = (): unknown => [{ path: "/a", cached: 1 }, { path: "/b", source: unrenderable }];

      expect(renderShadowMismatchLog(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { mismatchPaths: ["/a", "/b"], mismatchPathCount: 2, diffJson: null },
        failure: "render_error",
      });
      expect(renderShadowMismatchLog(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { mismatchPaths: ["/a", "/b"], mismatchPathCount: 2 },
        failure: null,
      });
    });

    it("stops rendering hook sides at the first side with no rendering", () => {
      const later = { toJSON: vi.fn(() => "later") };
      const hook = (): unknown => [{ path: "/a", cached: 1n }, { path: "/b", source: later }];

      expect(renderShadowMismatchLog(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { mismatchPaths: ["/a", "/b"], mismatchPathCount: 2, diffJson: null },
        failure: "render_error",
      });
      expect(later.toJSON).not.toHaveBeenCalled();
    });

    it("omits absent hook sides from diffJson and renders present ones as JSON", () => {
      const hook = (): unknown => [
        { path: "/a" },
        { path: "/b", cached: 1 },
        { path: "/c", source: null },
        { path: "/d", cached: undefined, source: "x" },
        { path: "/at", cached: new Date("2026-07-31T00:00:00.000Z"), source: { ok: true } },
      ];

      expect(renderShadowMismatchLog(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook).fields.diffJson).toBe(
        '[{"path":"/a"},{"path":"/b","cached":1},{"path":"/c","source":null},{"path":"/d","source":"x"},'
          + '{"path":"/at","cached":"2026-07-31T00:00:00.000Z","source":{"ok":true}}]',
      );
    });

    it("clamps hook paths and sides and cuts at 64 with the total count", () => {
      const longPath = `/${"k".repeat(600)}`;
      const clampedPath = `/${"k".repeat(497)}${SHADOW_LOG_TRUNCATION_MARKER}`;
      const hook = (): unknown => [
        { path: longPath, cached: "x".repeat(2000), source: { ok: true } },
        ...Array.from({ length: 69 }, (_, index) => ({ path: `/${index + 1}` })),
      ];
      const retained = Array.from({ length: 63 }, (_, index) => `/${index + 1}`);

      const { fields, failure } = renderShadowMismatchLog(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook);

      expect(failure).toBeNull();
      expect(fields.mismatchPaths).toStrictEqual([clampedPath, ...retained]);
      expect(fields.mismatchPathCount).toBe(70);
      expect(JSON.parse(fields.diffJson!)).toStrictEqual([
        { path: clampedPath, cached: `"${"x".repeat(1009)}${SHADOW_LOG_TRUNCATION_MARKER}`, source: { ok: true } },
        ...retained.map((path) => ({ path })),
      ]);
    });

    it("does not call the hook when diff is off", () => {
      const hook = vi.fn(() => [{ path: "/email" }]);

      expect(renderShadowMismatchLog(VALUE_ONLY, CACHED_USER, SOURCE_USER, hook)).toStrictEqual({
        fields: { cachedValueJson: CACHED_USER_JSON, sourceValueJson: SOURCE_USER_JSON },
        failure: null,
      });
      expect(hook).not.toHaveBeenCalled();
    });

    it("keeps the hook entries when a root side has no rendering", () => {
      expect(renderShadowMismatchLog(EVERYTHING, 1n, SOURCE_USER, () => [{ path: "/a" }])).toStrictEqual({
        fields: {
          mismatchPaths: ["/a"],
          mismatchPathCount: 1,
          diffJson: '[{"path":"/a"}]',
          cachedValueJson: null,
          sourceValueJson: SOURCE_USER_JSON,
        },
        failure: "render_error",
      });
    });

    it("reports hook_error ahead of render_error", () => {
      const hook = (): never => {
        throw new Error("hook failed");
      };

      expect(renderShadowMismatchLog(EVERYTHING, circular(), SOURCE_USER, hook)).toStrictEqual({
        fields: { ...FAILED_DIFF, cachedValueJson: null, sourceValueJson: SOURCE_USER_JSON },
        failure: "hook_error",
      });
    });
  });
});
