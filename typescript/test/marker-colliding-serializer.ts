import type { Serializer } from "../src/index.js";

export interface Row {
  readonly id: string;
}

/**
 * A binary serializer whose output begins with the 0x01 envelope byte — the
 * collision shape the escape prefix exists for. Shared by the unit, e2e, and
 * real-Redis tests that pin the escape contract so the fixture cannot drift
 * between them. Deliberately free of node:zlib imports and module-scope side
 * effects: files that vi.mock("node:zlib") must stay safe importing it.
 */
export const markerCollidingSerializer: Serializer<Row> = {
  dump: (row) => Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(row), "utf8")]),
  load: (payload) => {
    if (!Buffer.isBuffer(payload)) {
      throw new Error("expected binary payload");
    }
    return JSON.parse(payload.subarray(1).toString("utf8")) as Row;
  },
};
