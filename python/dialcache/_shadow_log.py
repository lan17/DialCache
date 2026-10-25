"""Bounded content of confirmed shadow-mismatch warnings.

Every field derives from one native JSON rendering of each compared value, so
a failure logs less, never more. The built-in difference computation walks the
two parsed renderings and reports RFC 6901 JSON Pointers.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ._callbacks import discard_awaitable
from .protocol import utf8_bytes
from .serializer import UNDEFINED

KEY_MAX_BYTES = 2 * 1024
VALUE_MAX_BYTES = 8 * 1024
DIFF_MAX_BYTES = 8 * 1024
MAX_ENTRIES = 64
PATH_MAX_BYTES = 512
SIDE_MAX_BYTES = 1024
# Reference tokens in the deepest pointer the built-in walk reports.
MAX_DEPTH = 32
TRUNCATION_MARKER = "...[truncated]"
_MARKER_BYTES = TRUNCATION_MARKER.encode()

# One difference: a pointer, and each side under "cached" or "source" when the
# value has that side. A missing key is an absent side; None is JSON null.
Entry = dict[str, Any]


@dataclass(frozen=True)
class MismatchLogPlan:
    """The effective content leaves captured when a shadow job is admitted."""

    value: bool
    diff: str


def clamp_utf8(text: str, limit: int) -> str:
    """Clamp to ``limit`` UTF-8 bytes with the marker, never splitting a code point."""
    encoded = utf8_bytes(text)
    if len(encoded) <= limit:
        return text
    return encoded[: limit - len(_MARKER_BYTES)].decode("utf-8", "ignore") + TRUNCATION_MARKER


def render_json(value: Any) -> str | None:
    """Compact native JSON, or None for a value without a JSON rendering.

    Lone surrogates are escaped as ``JsonSerializer`` and ECMAScript
    ``JSON.stringify`` escape them, so the rendering is valid UTF-8.
    """
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except Exception:
        return None
    return text.encode("utf-8", "backslashreplace").decode("utf-8")


def render_shadow_mismatch_log(
    plan: MismatchLogPlan,
    cached: Any,
    source: Any,
    hook: Callable[[Any, Any], Any] | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Build the content fields the plan requests for one confirmed mismatch.

    Returns the fields, each requested one present and None when it failed
    closed, and the failure: ``"hook_error"`` for the difference computation
    (hook or built-in walk), which ranks above ``"render_error"`` for JSON
    rendering, or None. Each side is rendered at most once. A failed hook never
    falls back to the built-in walk. A top-level ``UNDEFINED``, which a
    negative-cache entry stores, is an absent side rather than a failure: its
    value field is None, and the walk reports the other side whole at ``""``.
    """
    render_sides = plan.value or (plan.diff != "off" and hook is None)
    cached_json = render_json(cached) if render_sides else None
    source_json = render_json(source) if render_sides else None
    diff_failed = False
    render_failed = render_sides and (
        (cached_json is None and cached is not UNDEFINED) or (source_json is None and source is not UNDEFINED)
    )

    fields: dict[str, Any] = {}
    if plan.diff != "off":
        with_values = plan.diff == "values"
        diff: tuple[list[Entry], int] | None = None
        if hook is not None:
            diff = _run_hook(hook, cached, source)
            diff_failed = diff is None
        elif not render_failed:
            try:
                diff = _walk_rendered(cached_json, source_json)
            except Exception:
                diff_failed = True
        if diff is None:
            fields["mismatchPaths"] = None
            fields["mismatchPathCount"] = None
            if with_values:
                fields["diffJson"] = None
        else:
            entries, count = diff
            diff_json = None
            if with_values:
                diff_json = _render_diff_json(entries)
                render_failed = render_failed or diff_json is None
            # The paths level never renders a side.
            fields["mismatchPaths"] = [clamp_utf8(entry["path"], PATH_MAX_BYTES) for entry in entries]
            fields["mismatchPathCount"] = count
            if with_values:
                fields["diffJson"] = diff_json

    if plan.value:
        fields["cachedValueJson"] = None if cached_json is None else clamp_utf8(cached_json, VALUE_MAX_BYTES)
        fields["sourceValueJson"] = None if source_json is None else clamp_utf8(source_json, VALUE_MAX_BYTES)
    return fields, "hook_error" if diff_failed else "render_error" if render_failed else None


def diff_shadow_mismatch_json(cached: Any, source: Any) -> tuple[list[Entry | None], int]:
    """The built-in difference computation over two JSON values.

    Objects recurse over the union of their member names in UTF-16 code-unit
    order, and a member on one side only is reported with that side. Arrays of
    equal length recurse by index; arrays of different length are reported once
    at their own pointer. Any other differing pair, roots of different kinds
    included, is reported with both sides, and a differing pair of containers
    at ``MAX_DEPTH`` reference tokens is reported whole. Entries keep walk
    order and are cut at ``MAX_ENTRIES``; the count is the uncut total. Each
    pointer and side is clamped as in ``diffJson``.
    """
    entries, count = _walk(cached, source)
    # JSON values always render, so every entry bounds.
    return [_bound_entry(entry) for entry in entries], count


def _walk_rendered(cached_json: str | None, source_json: str | None) -> tuple[list[Entry], int]:
    # None is an absent side; a side that failed to render never reaches here.
    if cached_json == source_json:
        return [], 0
    # Each string came from a successful native rendering, so this is the one
    # boundary from arbitrary values to the closed JSON domain.
    if cached_json is None:
        return [{"path": "", "source": json.loads(source_json)}], 1
    if source_json is None:
        return [{"path": "", "cached": json.loads(cached_json)}], 1
    return _walk(json.loads(cached_json), json.loads(source_json))


def _walk(cached: Any, source: Any) -> tuple[list[Entry], int]:
    entries: list[Entry] = []
    count = 0

    def report(entry: Entry) -> None:
        nonlocal count
        count += 1
        if len(entries) < MAX_ENTRIES:
            entries.append(entry)

    def walk(left: Any, right: Any, path: str, depth: int) -> None:
        kind = _kind(left)
        if kind != _kind(right) or kind == "primitive":
            if not _same_primitive(left, right):
                report({"path": path, "cached": left, "source": right})
            return
        if depth >= MAX_DEPTH:
            if not _json_equal(left, right):
                report({"path": path, "cached": left, "source": right})
            return
        if kind == "array":
            if len(left) != len(right):
                report({"path": path, "cached": left, "source": right})
                return
            for index, (item, other) in enumerate(zip(left, right)):
                walk(item, other, f"{path}/{index}", depth + 1)
            return
        for name in sorted(left.keys() | right.keys(), key=_utf16_order):
            member = f"{path}/{_escape_token(name)}"
            if name not in right:
                report({"path": member, "cached": left[name]})
            elif name not in left:
                report({"path": member, "source": right[name]})
            else:
                walk(left[name], right[name], member, depth + 1)

    walk(cached, source, "", 0)
    return entries, count


def _json_equal(cached: Any, source: Any) -> bool:
    # Structural equality for a depth-capped pair, iterative so that a subtree
    # as deep as native JSON rendering allows cannot exhaust the stack.
    pending = [(cached, source)]
    while pending:
        left, right = pending.pop()
        kind = _kind(left)
        if kind != _kind(right):
            return False
        if kind == "primitive":
            if not _same_primitive(left, right):
                return False
        elif kind == "array":
            if len(left) != len(right):
                return False
            pending.extend(zip(left, right))
        else:
            if len(left) != len(right):
                return False
            for name, value in left.items():
                if name not in right:
                    return False
                pending.append((value, right[name]))
    return True


def _kind(value: Any) -> str:
    if isinstance(value, list):
        return "array"
    return "object" if isinstance(value, dict) else "primitive"


def _same_primitive(left: Any, right: Any) -> bool:
    # JSON equality, not Python's: True == 1 and False == 0 in Python.
    if isinstance(left, bool) or isinstance(right, bool) or left is None or right is None:
        return left is right
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    return False


def _utf16_order(name: str) -> bytes:
    # Big-endian code units compare as UTF-16 code units, the W02 key order.
    return name.encode("utf-16-be", "surrogatepass")


def _escape_token(name: str) -> str:
    return name.replace("~", "~0").replace("/", "~1")


def _run_hook(hook: Callable[[Any, Any], Any], cached: Any, source: Any) -> tuple[list[Entry], int] | None:
    """Run the use case's hook under the comparator's synchronous discipline.

    A raise, an awaitable, a result that is not a list, or a member that is
    not a mapping with a str ``"path"`` returns None. Members are read here,
    so a failing mapping counts against the hook rather than against rendering.
    """
    try:
        result = hook(cached, source)
        if inspect.isawaitable(result):
            # The contract is synchronous: fail closed without driving it.
            discard_awaitable(result)
            return None
        if not isinstance(result, list):
            return None
        entries: list[Entry] = []
        for member in result:
            if not isinstance(member, Mapping):
                return None
            path = member["path"] if "path" in member else None
            if not isinstance(path, str):
                return None
            if len(entries) < MAX_ENTRIES:
                entry: Entry = {"path": path}
                for side in ("cached", "source"):
                    if side in member and member[side] is not UNDEFINED:
                        entry[side] = member[side]
                entries.append(entry)
        return entries, len(result)
    except (Exception, asyncio.CancelledError):
        return None


def _render_diff_json(entries: list[Entry]) -> str | None:
    # A side with no JSON rendering makes the whole field None, and later
    # sides are not rendered.
    bounded = []
    for entry in entries:
        next_entry = _bound_entry(entry)
        if next_entry is None:
            return None
        bounded.append(next_entry)
    text = render_json(bounded)
    return None if text is None else clamp_utf8(text, DIFF_MAX_BYTES)


def _bound_entry(entry: Entry) -> Entry | None:
    """Clamp the pointer, and keep each present side as JSON or as its clamped text.

    One clamp rule for built-in and hook entries. None when a side has no JSON
    rendering.
    """
    bounded: Entry = {"path": clamp_utf8(entry["path"], PATH_MAX_BYTES)}
    for side in ("cached", "source"):
        if side not in entry:
            continue
        text = render_json(entry[side])
        if text is None:
            return None
        clamped = clamp_utf8(text, SIDE_MAX_BYTES)
        # Parsing the one rendering keeps each side rendered once.
        bounded[side] = json.loads(text) if clamped is text else clamped
    return bounded
