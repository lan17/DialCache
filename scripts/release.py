#!/usr/bin/env python3
"""Version-only release commits and idempotent crates.io publication checks.

Requires Python 3.11+ (tomllib); uses no third-party packages.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tomllib
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
VERSION_FILES = ("typescript/package.json", "rust/Cargo.toml", "rust/Cargo.lock", "python/pyproject.toml")
CRATE_INDEX = "https://index.crates.io/di/al/dialcache"


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root).decode("utf-8")


def validate_version(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError(f"Expected a stable release version; got {version!r}")


def replace_version_line(text, old, version):
    pattern = rf'(?m)^version = "{re.escape(old)}"$'
    result, count = re.subn(pattern, f'version = "{version}"', text)
    if count != 1:
        raise ValueError("Expected exactly one version line in the selected TOML table")
    return result


def versioned_files(contents, version):
    """Preserve every byte except the four package version values."""
    validate_version(version)
    package = json.loads(contents["typescript/package.json"])
    manifest = tomllib.loads(contents["rust/Cargo.toml"])
    lock = tomllib.loads(contents["rust/Cargo.lock"])
    python = tomllib.loads(contents["python/pyproject.toml"])
    if package["name"] != "dialcache" or manifest["package"]["name"] != "dialcache":
        raise ValueError("Expected the dialcache npm package and Rust crate")
    local = [p for p in lock["package"] if p["name"] == "dialcache" and "source" not in p]
    if len(local) != 1 or local[0]["version"] != manifest["package"]["version"]:
        raise ValueError("Cargo manifest and root lockfile package must agree")
    project = python.get("project", {})
    if not isinstance(project, dict) or project.get("name") != "dialcache":
        raise ValueError("Expected the dialcache Python project")
    python_version = project.get("version")
    dynamic = project.get("dynamic", [])
    if (
        not isinstance(python_version, str) or not python_version
        or not isinstance(dynamic, list) or "version" in dynamic
    ):
        raise ValueError("Expected a static Python project version")

    result = dict(contents)
    pattern = rf'(?m)^(  "version": )"{re.escape(package["version"])}"(,?)$'
    result["typescript/package.json"], count = re.subn(
        pattern, lambda m: f'{m[1]}"{version}"{m[2]}', contents["typescript/package.json"]
    )
    if count != 1:
        raise ValueError("Expected exactly one top-level npm version line")

    # Parse with tomllib above, then edit only the selected table in the original
    # text. Regenerating Cargo.lock could silently upgrade unrelated dependencies.
    tables = re.split(r"(?m)(?=^\[)", contents["rust/Cargo.toml"])
    matches = [i for i, table in enumerate(tables) if table.startswith("[package]\n")]
    if len(matches) != 1:
        raise ValueError("Expected one explicit Cargo package table")
    i = matches[0]
    tables[i] = replace_version_line(tables[i], manifest["package"]["version"], version)
    result["rust/Cargo.toml"] = "".join(tables)

    tables = re.split(r"(?m)(?=^\[\[package\]\])", contents["rust/Cargo.lock"])
    matches = [
        i for i, table in enumerate(tables)
        if table.startswith("[[package]]\n")
        and tomllib.loads(table)["package"][0] == local[0]
    ]
    if len(matches) != 1:
        raise ValueError("Expected one root Cargo lockfile table")
    i = matches[0]
    tables[i] = replace_version_line(tables[i], local[0]["version"], version)
    result["rust/Cargo.lock"] = "".join(tables)

    # The first Python publication may start from a different package version.
    # Its only permitted change is the explicit [project].version value.
    tables = re.split(r"(?m)(?=^\[)", contents["python/pyproject.toml"])
    matches = [i for i, table in enumerate(tables) if table.startswith("[project]\n")]
    if len(matches) != 1:
        raise ValueError("Expected one explicit Python project table")
    i = matches[0]
    tables[i] = replace_version_line(tables[i], python_version, version)
    result["python/pyproject.toml"] = "".join(tables)
    if tomllib.loads(result["python/pyproject.toml"])["project"]["version"] != version:
        raise ValueError("Expected to update the static Python project version")
    return result


def update_versions(root, version):
    contents = {p: (root / p).read_bytes().decode("utf-8") for p in VERSION_FILES}
    updated = versioned_files(contents, version)
    for path, text in updated.items():
        (root / path).write_bytes(text.encode("utf-8"))


def verify_version_commit(root, version, base, head):
    validate_version(version)
    contents = {p: git(root, "show", f"{base}:{p}") for p in VERSION_FILES}
    previous = json.loads(contents["typescript/package.json"])["version"]
    validate_version(previous)
    if tuple(map(int, version.split("."))) <= tuple(map(int, previous.split("."))):
        raise ValueError("A release must increase the package version")
    expected = versioned_files(contents, version)
    changed = git(root, "diff", "--name-only", base, head).splitlines()
    if sorted(changed) != sorted(VERSION_FILES):
        raise ValueError(f"Release must change exactly {VERSION_FILES}; got {changed}")
    for path in VERSION_FILES:
        actual = git(root, "show", f"{head}:{path}")
        if actual != expected[path]:
            raise ValueError(f"Release contains changes beyond the selected version in {path}")
    # File modes are release content too: a version bump cannot change them.
    for path in VERSION_FILES:
        if git(root, "ls-tree", base, "--", path).split()[0] != git(root, "ls-tree", head, "--", path).split()[0]:
            raise ValueError(f"Release changes the file mode of {path}")


def published_crate_matches(index, version, archive):
    """Accept a retry only when the registry contains this exact packaged crate."""
    validate_version(version)
    entries = [json.loads(line) for line in index.splitlines() if line.strip()]
    matching = [entry for entry in entries if entry["vers"] == version]
    if not matching:
        return False
    if len(matching) != 1 or matching[0]["name"] != "dialcache" or matching[0]["yanked"]:
        raise ValueError("Existing crate version is conflicting or yanked")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    if matching[0]["cksum"] != checksum:
        raise ValueError("Existing crates.io version has different contents; refusing to skip publication")
    return True


def check_published(version, archive):
    request = urllib.request.Request(
        CRATE_INDEX, headers={"User-Agent": "DialCache release (https://github.com/lan17/DialCache)"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            index = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        index = ""
    return published_crate_matches(index, version, archive)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    update = commands.add_parser("update")
    update.add_argument("version")
    verify = commands.add_parser("verify")
    verify.add_argument("version")
    verify.add_argument("base")
    verify.add_argument("head")
    published = commands.add_parser("published")
    published.add_argument("version")
    published.add_argument("archive", type=Path)
    args = parser.parse_args()
    if args.command == "update":
        update_versions(args.root, args.version)
    elif args.command == "verify":
        verify_version_commit(args.root, args.version, args.base, args.head)
    else:
        print(f"published={str(check_published(args.version, args.archive)).lower()}")


if __name__ == "__main__":
    main()
