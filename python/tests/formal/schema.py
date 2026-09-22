"""Validate the coordinator's JSON Schema locally before every round trip."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def strict_json(text):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON object member: {key}")
            result[key] = value
        return result

    def constant(value):
        raise ValueError(f"Non-JSON numeric constant: {value}")

    return json.loads(text, object_pairs_hook=object_pairs, parse_constant=constant)


SCHEMA = strict_json((ROOT / "formal/replay/protocol.schema.json").read_text())
KEYWORDS = {
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "oneOf",
    "anyOf",
    "const",
    "enum",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
}


def _supported(rule):
    unknown = set(rule) - KEYWORDS
    if unknown:
        raise RuntimeError(f"Unsupported replay schema keywords: {unknown}")
    for key in ("$defs", "properties"):
        for child in rule.get(key, {}).values():
            _supported(child)
    for key in ("oneOf", "anyOf"):
        for child in rule.get(key, []):
            _supported(child)
    if "items" in rule:
        _supported(rule["items"])
    if isinstance(rule.get("additionalProperties"), dict):
        _supported(rule["additionalProperties"])


def _equal(left, right):
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_equal(value, right[key]) for key, value in left.items())
    return left == right


json_equal = _equal


def matches(value, rule):
    if "$ref" in rule:
        return matches(value, SCHEMA["$defs"][rule["$ref"].removeprefix("#/$defs/")])
    if "oneOf" in rule and sum(matches(value, item) for item in rule["oneOf"]) != 1:
        return False
    if "anyOf" in rule and not any(matches(value, item) for item in rule["anyOf"]):
        return False
    if "const" in rule and not _equal(value, rule["const"]):
        return False
    if "enum" in rule and not any(_equal(value, option) for option in rule["enum"]):
        return False
    if "type" in rule:
        types = rule["type"] if isinstance(rule["type"], list) else [rule["type"]]
        predicates = {
            "null": lambda: value is None,
            "array": lambda: isinstance(value, list),
            "object": lambda: isinstance(value, dict),
            "boolean": lambda: type(value) is bool,
            "string": lambda: isinstance(value, str),
            "number": lambda: type(value) in (int, float) and math.isfinite(value),
            "integer": lambda: type(value) in (int, float) and math.isfinite(value) and int(value) == value,
        }
        if not any(predicates[kind]() for kind in types):
            return False
    if type(value) in (int, float):
        if value < rule.get("minimum", -math.inf) or value > rule.get("maximum", math.inf):
            return False
    if isinstance(value, str):
        if len(value) < rule.get("minLength", 0) or (
            "pattern" in rule and not re.search(rule["pattern"], value)
        ):
            return False
    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0) or (
            "items" in rule and not all(matches(item, rule["items"]) for item in value)
        ):
            return False
    if isinstance(value, dict):
        if any(key not in value for key in rule.get("required", [])):
            return False
        for key, item in value.items():
            if key in rule.get("properties", {}):
                if not matches(item, rule["properties"][key]):
                    return False
            elif rule.get("additionalProperties") is False:
                return False
            elif isinstance(rule.get("additionalProperties"), dict) and not matches(
                item, rule["additionalProperties"]
            ):
                return False
    return True


def validate(value, definition):
    if definition not in SCHEMA["$defs"]:
        raise RuntimeError(f"Unknown replay schema definition: {definition}")
    if not matches(value, SCHEMA["$defs"][definition]):
        raise RuntimeError(f"Malformed native replay {definition}: {json.dumps(value, default=str)}")


_supported(SCHEMA)
