"""Build validated Python artifacts and safely resume their PyPI publication.

This helper never uploads packages. A retry must reuse the original release
artifacts: PyPI's hashes are compared to those exact bytes before selecting the
files that the Trusted Publishing action should upload.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
import venv
import zipfile
from email.parser import BytesParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "dialcache"
VERSION_PATTERN = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")


class ReleaseError(ValueError):
    """The release cannot safely proceed."""


def validate_version(version: str) -> str:
    if not VERSION_PATTERN.fullmatch(version):
        raise ReleaseError(f"Expected a stable X.Y.Z version, got {version!r}")
    return version


def project_version(root: Path) -> str:
    project = tomllib.loads((root / "python/pyproject.toml").read_text())["project"]
    if project.get("name") != PROJECT:
        raise ReleaseError("Python project must be named dialcache")
    return validate_version(project["version"])


def metadata_identity(data: bytes, version: str, filename: str) -> None:
    metadata = BytesParser().parsebytes(data)
    if metadata.get_all("Name") != [PROJECT] or metadata.get_all("Version") != [version]:
        raise ReleaseError(f"Incorrect or ambiguous package identity in {filename}")


def artifacts(dist_dir: Path, version: str) -> dict[str, Path]:
    """Require exactly the universal wheel and source archive we publish."""
    validate_version(version)
    if dist_dir.is_symlink() or not dist_dir.is_dir():
        raise ReleaseError(f"Artifact directory must be a real directory: {dist_dir}")
    expected = {
        f"{PROJECT}-{version}-py3-none-any.whl",
        f"{PROJECT}-{version}.tar.gz",
    }
    found = {path.name: path for path in dist_dir.iterdir()}
    if set(found) != expected:
        raise ReleaseError(f"Expected only {sorted(expected)}, found {sorted(found)}")
    for path in found.values():
        if path.is_symlink() or not path.is_file():
            raise ReleaseError(f"Artifact must be a regular file: {path}")

    wheel = found[f"{PROJECT}-{version}-py3-none-any.whl"]
    dist_info = f"{PROJECT}-{version}.dist-info"
    try:
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ReleaseError("Wheel contains duplicate members")
            expected_metadata = f"{dist_info}/METADATA"
            if [name for name in names if name.endswith(".dist-info/METADATA")] != [expected_metadata]:
                raise ReleaseError("Wheel must contain exactly one expected package metadata file")
            metadata_identity(archive.read(expected_metadata), version, wheel.name)
            for member in ("dialcache/__init__.py", "dialcache/py.typed", f"{dist_info}/licenses/LICENSE"):
                if member not in names:
                    raise ReleaseError(f"Wheel is missing {member}")
            wheel_metadata = BytesParser().parsebytes(archive.read(f"{dist_info}/WHEEL"))
            if wheel_metadata.get_all("Tag") != ["py3-none-any"]:
                raise ReleaseError("Wheel must be a universal py3-none-any wheel")

        source = found[f"{PROJECT}-{version}.tar.gz"]
        prefix = f"{PROJECT}-{version}"
        with tarfile.open(source, "r:gz") as archive:
            members = archive.getmembers()
            if len(members) != len({member.name for member in members}):
                raise ReleaseError("Source archive contains duplicate members")
            for member in (f"{prefix}/PKG-INFO", f"{prefix}/pyproject.toml", f"{prefix}/LICENSE"):
                if not archive.getmember(member).isfile():
                    raise ReleaseError(f"Source archive is missing a regular {member}")
            metadata_file = archive.extractfile(f"{prefix}/PKG-INFO")
            project_file = archive.extractfile(f"{prefix}/pyproject.toml")
            assert metadata_file is not None and project_file is not None
            metadata_identity(metadata_file.read(), version, source.name)
            project = tomllib.loads(project_file.read().decode("utf-8"))["project"]
            if project.get("name") != PROJECT or project.get("version") != version:
                raise ReleaseError("Source archive pyproject.toml has a different package identity")
    except (zipfile.BadZipFile, tarfile.TarError, KeyError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise ReleaseError(f"Invalid Python release artifact: {exc}") from exc
    return found


def empty_directory(path: Path) -> None:
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise ReleaseError(f"Output directory must be absent or empty: {path}")
    path.mkdir(parents=True, exist_ok=True)


SMOKE = """
import asyncio
from importlib import metadata
from pathlib import Path
import sys

import dialcache
from dialcache import DialCache, Policy
from dialcache.redis import RedisAdapter
from redis.asyncio import Redis
import zstandard

assert Path(dialcache.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
package = metadata.distribution("dialcache")
assert package.version == sys.argv[1], (package.version, sys.argv[1])
assert package.metadata["Name"] == "dialcache"
assert "redis" in package.metadata.get_all("Provides-Extra", [])
assert package.read_text("licenses/LICENSE")
assert Path(dialcache.__file__).with_name("py.typed").is_file()
assert RedisAdapter and Redis and zstandard

async def main():
    cache = DialCache(namespace="installed-package-smoke")
    calls = 0

    @cache.cached(
        use_case="smoke", key_type="item", id_arg="item_id",
        default_config=Policy(ttl_sec={"local": 30}, request_local=True),
    )
    async def load(item_id):
        nonlocal calls
        calls += 1
        return {"id": item_id, "calls": calls}

    assert (await load("one"))["calls"] == 1
    assert (await load("one"))["calls"] == 2
    async with cache.enable():
        assert (await load("one"))["calls"] == 3
        assert (await load("one"))["calls"] == 3
    async with cache.enable():
        assert (await load("one"))["calls"] == 3
    assert (await load("one"))["calls"] == 4

asyncio.run(main())
"""


def smoke_install(wheel: Path, version: str) -> None:
    # Neither the checkout nor its development environment may satisfy imports.
    with tempfile.TemporaryDirectory(prefix="dialcache-release-smoke-") as temporary:
        directory = Path(temporary)
        environment = directory / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        executable = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        subprocess.run(
            [str(executable), "-I", "-m", "pip", "install", f"dialcache[redis] @ {wheel.resolve().as_uri()}"],
            cwd=directory,
            check=True,
        )
        subprocess.run([str(executable), "-I", "-c", SMOKE, version], cwd=directory, check=True)


def build(out_dir: Path, version: str | None = None, root: Path = ROOT) -> None:
    actual_version = project_version(root)
    if version is not None and validate_version(version) != actual_version:
        raise ReleaseError(f"Expected version {version}, checkout contains {actual_version}")
    out_dir = out_dir.absolute()
    empty_directory(out_dir)
    # No --wheel flag: build first creates the sdist, then builds its wheel from
    # that sdist, so an incomplete source archive fails before publication.
    subprocess.run(
        [sys.executable, "-m", "build", "--outdir", str(out_dir), str(root / "python")], check=True
    )
    files = artifacts(out_dir, actual_version)
    subprocess.run(
        [sys.executable, "-m", "twine", "check", "--strict", *[str(path) for path in files.values()]],
        check=True,
    )
    smoke_install(files[f"{PROJECT}-{actual_version}-py3-none-any.whl"], actual_version)


def registry_release(version: str) -> dict | None:
    validate_version(version)
    request = urllib.request.Request(
        f"https://pypi.org/pypi/{PROJECT}/{version}/json",
        headers={"Accept": "application/json", "User-Agent": "DialCache-release"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            release = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise ReleaseError(
            f"PyPI returned HTTP {exc.code}; refusing to assume the version is absent"
        ) from exc
    except (OSError, ValueError) as exc:
        raise ReleaseError(f"Cannot read PyPI release metadata: {exc}") from exc
    if not isinstance(release, dict):
        raise ReleaseError("PyPI release metadata must be an object")
    return release


def missing_artifacts(version: str, files: dict[str, Path], release: dict | None) -> list[Path]:
    if release is None:
        return list(files.values())
    info = release.get("info")
    if not isinstance(info, dict) or info.get("name") != PROJECT or info.get("version") != version:
        raise ReleaseError("PyPI returned a different package identity")
    if info.get("yanked", False):
        raise ReleaseError("PyPI release is yanked")
    distributions = release.get("urls")
    if not isinstance(distributions, list) or not distributions:
        raise ReleaseError("PyPI release metadata must contain distribution files")
    seen = set()
    for distribution in distributions:
        if not isinstance(distribution, dict):
            raise ReleaseError("Invalid PyPI distribution metadata")
        filename = distribution.get("filename")
        if not isinstance(filename, str) or filename not in files or filename in seen:
            raise ReleaseError(f"Unexpected or duplicate file already on PyPI: {filename!r}")
        seen.add(filename)
        if distribution.get("yanked") is not False:
            raise ReleaseError(f"PyPI file is yanked or lacks yanked status: {filename}")
        expected_type = "bdist_wheel" if filename.endswith(".whl") else "sdist"
        if distribution.get("packagetype") != expected_type:
            raise ReleaseError(f"Incorrect PyPI distribution type: {filename}")
        digests = distribution.get("digests")
        expected_hash = hashlib.sha256(files[filename].read_bytes()).hexdigest()
        if not isinstance(digests, dict) or digests.get("sha256") != expected_hash:
            raise ReleaseError(f"PyPI already has different bytes for {filename}")
    return [path for filename, path in files.items() if filename not in seen]


def pending(version: str, dist_dir: Path, upload_dir: Path) -> bool:
    files = artifacts(dist_dir, version)
    missing = missing_artifacts(version, files, registry_release(version))
    empty_directory(upload_dir)
    for path in missing:
        shutil.copyfile(path, upload_dir / path.name)
    return bool(missing)


def verify_published(version: str, dist_dir: Path, *, attempts: int = 12, delay: float = 15) -> None:
    files = artifacts(dist_dir, version)
    if attempts < 1:
        raise ReleaseError("At least one publication verification attempt is required")
    # Accepted uploads can take longer than 25 seconds to appear in PyPI's JSON
    # API. Poll only for missing files; identity conflicts and HTTP errors still
    # fail immediately, and verification never uploads or rebuilds anything.
    for attempt in range(attempts):
        missing = missing_artifacts(version, files, registry_release(version))
        if not missing:
            return
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise ReleaseError(f"PyPI is missing release files: {', '.join(path.name for path in missing)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="Build, check, and smoke-test both distributions")
    build_parser.add_argument("--out-dir", required=True, type=Path)
    build_parser.add_argument("--version")
    pending_parser = commands.add_parser("pending", help="Copy only missing exact artifacts for upload")
    pending_parser.add_argument("version")
    pending_parser.add_argument("dist_dir", type=Path)
    pending_parser.add_argument("upload_dir", type=Path)
    verify_parser = commands.add_parser("verify-published", help="Verify PyPI contains the exact release")
    verify_parser.add_argument("version")
    verify_parser.add_argument("dist_dir", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.out_dir, args.version)
        elif args.command == "pending":
            has_pending = pending(args.version, args.dist_dir, args.upload_dir)
            print(f"pending={'true' if has_pending else 'false'}")
        else:
            verify_published(args.version, args.dist_dir)
    except (ReleaseError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Python release error: {exc}\n")


if __name__ == "__main__":
    main()
