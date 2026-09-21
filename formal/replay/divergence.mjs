import assert, { AssertionError } from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const observationComparison = Symbol("complete observation comparison");

// Projection may itself assert a value's domain or an event's labels. Only
// this final comparison has both complete records and can safely be recorded
// while continuing: otherwise an unexamined counter could look newly wrong
// at the next step. Arguments are projected before this function is entered.
export function assertObservation(actual, expected) {
  try { assert.deepEqual(actual, expected); }
  catch (error) {
    if (error instanceof AssertionError) Object.defineProperty(error, observationComparison, { value: true });
    throw error;
  }
}
export const isObservationComparison = error => error instanceof AssertionError && error[observationComparison] === true;

// Paths name the record actually compared by a binding, including array
// indices. A scalar comparison has no named field and is recorded as `$`;
// it cannot establish evidence for an unrelated observation field.
export function diffPaths(expected, actual, prefix = "") {
  if (isDeepStrictEqual(expected, actual)) return [];
  const composite = value => value !== null && typeof value === "object";
  const path = key => prefix ? `${prefix}.${key}` : String(key);
  if (composite(expected) && composite(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = Array.isArray(expected)
      ? [...Array(Math.max(expected.length, actual.length)).keys()]
      : Object.keys({ ...expected, ...actual }).sort();
    const paths = keys.flatMap(key => Object.hasOwn(expected, key) !== Object.hasOwn(actual, key)
      ? [path(key)] : diffPaths(expected[key], actual[key], path(key)));
    if (Array.isArray(expected) && expected.length !== actual.length) paths.push(path("length"));
    return paths.length ? paths : [prefix || "$"];
  }
  return [prefix || "$"];
}

const counters = new Set([
  "o.loaders", "o.reads", "o.loads", "o.dumps", "o.writes", "o.policyCalls", "o.invalidations", "o.classifications", "o.comparisons",
  "d.configErrors", "d.warnings",
  // Effects and local-clock compare these same counters without an `o`
  // wrapper. Paths retain the binding's spelling in every evidence packet.
  "loaders", "reads", "loads", "dumps", "writes", "policyCalls", "invalidations", "classifications", "comparisons",
]);
const within = (path, field) => path === field || path.startsWith(`${field}.`);

// Consequences count whenever they differ at the requested checkpoint. A
// cumulative counter counts only when it was not already divergent at the
// immediately preceding observation, even if an earlier step differed too.
export function countingPaths(fields, at, before = []) {
  return at.filter(path => fields.some(field => within(path, field)
    && (!counters.has(field) || !before.some(previous => within(previous, field)))));
}
