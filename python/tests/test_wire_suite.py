"""Keep the cross-language inventory complete and its value assertions strict."""

import importlib.util
from itertools import permutations
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("wire_cases", ROOT / "interop/test_wire_interop.py")
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)


def test_all_directed_pairs_and_supported_value_domains_are_required():
    languages = {"typescript", "go", "rust", "python"}
    assert set(wire.LANGUAGES) == languages
    assert set(wire.DIRECTIONS) == set(permutations(languages, 2))
    assert len(wire.DIRECTIONS) == 12
    assert len(wire.VALUE_CASES) == 69
    common = {"json-raw", "json-zstd", "null", "binary-escaped", "binary-zstd"}
    for writer, reader in wire.DIRECTIONS:
        cases = {
            case.id.removeprefix(f"{writer}-to-{reader}-")
            for case in wire.VALUE_CASES
            if case.values[:2] == (writer, reader)
        }
        assert cases == common | ({"undefined"} if writer != "rust" else set())


@pytest.mark.parametrize("actual,expected", [(False, 0), (0, False), (True, 1), (1, True)])
def test_json_equality_rejects_boolean_number_substitution(actual, expected):
    with pytest.raises(AssertionError):
        wire.assert_value({"nested": [actual]}, {"nested": [expected]})


def test_json_equality_accepts_equivalent_native_number_representations():
    wire.assert_value({"nested": [None, False, True, 1.0]}, {"nested": [None, False, True, 1]})
