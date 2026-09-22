"""Exercise Python release identity and retry boundaries without a live registry."""

import hashlib
import io
import json
import tarfile
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

import python_release

VERSION = "0.24.0"
WHEEL = f"dialcache-{VERSION}-py3-none-any.whl"
SOURCE = f"dialcache-{VERSION}.tar.gz"


def write_artifacts(directory, *, wheel_name="dialcache", wheel_version=VERSION, source_version=VERSION):
    directory.mkdir(exist_ok=True)
    dist_info = f"dialcache-{VERSION}.dist-info"
    with zipfile.ZipFile(directory / WHEEL, "w") as archive:
        archive.writestr(f"{dist_info}/METADATA", f"Name: {wheel_name}\nVersion: {wheel_version}\n")
        archive.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\nTag: py3-none-any\n")
        archive.writestr(f"{dist_info}/licenses/LICENSE", "MIT")
        archive.writestr("dialcache/py.typed", "")
        archive.writestr("dialcache/__init__.py", "")
    with tarfile.open(directory / SOURCE, "w:gz") as archive:
        for name, contents in {
            "PKG-INFO": f"Name: dialcache\nVersion: {source_version}\n",
            "pyproject.toml": f'[project]\nname = "dialcache"\nversion = "{source_version}"\n',
            "LICENSE": "MIT",
        }.items():
            member = tarfile.TarInfo(f"dialcache-{VERSION}/{name}")
            data = contents.encode()
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))


def release_metadata(directory, names=(WHEEL, SOURCE)):
    return {
        "info": {"name": "dialcache", "version": VERSION, "yanked": False},
        "urls": [
            {
                "filename": name,
                "packagetype": "bdist_wheel" if name.endswith(".whl") else "sdist",
                "yanked": False,
                "digests": {"sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest()},
            }
            for name in names
        ],
    }


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.dist = self.root / "dist"
        write_artifacts(self.dist)


class ArtifactTests(ReleaseFixture):
    def test_accepts_exact_two_artifacts(self):
        self.assertEqual(set(python_release.artifacts(self.dist, VERSION)), {WHEEL, SOURCE})

    def test_rejects_missing_unexpected_and_directory_artifacts(self):
        for change in ("missing", "unexpected", "directory", "symlink"):
            with self.subTest(change=change):
                directory = self.root / change
                write_artifacts(directory)
                if change == "missing":
                    (directory / WHEEL).unlink()
                elif change == "unexpected":
                    (directory / "surprise.whl").write_text("extra")
                else:
                    (directory / WHEEL).unlink()
                    if change == "directory":
                        (directory / WHEEL).mkdir()
                    else:
                        (directory / WHEEL).symlink_to(self.dist / WHEEL)
                with self.assertRaises(python_release.ReleaseError):
                    python_release.artifacts(directory, VERSION)

    def test_rejects_identity_mismatch_in_either_artifact(self):
        for kwargs in ({"wheel_name": "other"}, {"wheel_version": "0.1.0"}, {"source_version": "0.1.0"}):
            with self.subTest(kwargs=kwargs):
                write_artifacts(self.dist, **kwargs)
                with self.assertRaises(python_release.ReleaseError):
                    python_release.artifacts(self.dist, VERSION)

    def test_rejects_ambiguous_metadata(self):
        with self.assertRaises(python_release.ReleaseError):
            python_release.metadata_identity(
                b"Name: dialcache\nName: other\nVersion: 0.24.0\n", VERSION, WHEEL
            )

    def test_rejects_broken_archive(self):
        (self.dist / WHEEL).write_bytes(b"not a wheel")
        with self.assertRaises(python_release.ReleaseError):
            python_release.artifacts(self.dist, VERSION)

    def test_rejects_missing_typed_marker_license_or_platform_wheel(self):
        for member in ("dialcache/py.typed", f"dialcache-{VERSION}.dist-info/licenses/LICENSE", "platform"):
            with self.subTest(member=member):
                write_artifacts(self.dist)
                with zipfile.ZipFile(self.dist / WHEEL) as archive:
                    contents = {name: archive.read(name) for name in archive.namelist() if name != member}
                if member == "platform":
                    contents[f"dialcache-{VERSION}.dist-info/WHEEL"] = b"Tag: cp311-cp311-linux_x86_64\n"
                with zipfile.ZipFile(self.dist / WHEEL, "w") as archive:
                    for name, data in contents.items():
                        archive.writestr(name, data)
                with self.assertRaises(python_release.ReleaseError):
                    python_release.artifacts(self.dist, VERSION)

    def test_rejects_unsafe_or_non_stable_versions(self):
        for version in ("../0.24.0", "0.24.0rc1", "v0.24.0", "01.2.3", "0.24.0\n", "0.24"):
            with self.subTest(version=version), self.assertRaises(python_release.ReleaseError):
                python_release.validate_version(version)

    def test_output_directory_does_not_delete_existing_files(self):
        with self.assertRaises(python_release.ReleaseError):
            python_release.empty_directory(self.dist)
        self.assertEqual(set(path.name for path in self.dist.iterdir()), {WHEEL, SOURCE})

    def test_output_directory_rejects_symlink(self):
        empty = self.root / "empty"
        empty.mkdir()
        link = self.root / "link"
        link.symlink_to(empty)
        with self.assertRaises(python_release.ReleaseError):
            python_release.empty_directory(link)

    def test_build_checks_requested_version_before_any_command(self):
        project = self.root / "python"
        project.mkdir()
        (project / "pyproject.toml").write_text('[project]\nname = "dialcache"\nversion = "0.1.0"\n')
        with patch.object(python_release.subprocess, "run") as run:
            with self.assertRaises(python_release.ReleaseError):
                python_release.build(self.root / "output", VERSION, self.root)
            run.assert_not_called()

    def test_build_uses_sdist_default_and_checks_then_installs_artifacts(self):
        project = self.root / "python"
        project.mkdir()
        (project / "pyproject.toml").write_text(f'[project]\nname = "dialcache"\nversion = "{VERSION}"\n')
        output = self.root / "output"

        def run(command, **kwargs):
            if "build" in command:
                self.assertNotIn("--wheel", command)
                self.assertNotIn("--sdist", command)
                write_artifacts(output)

        with patch.object(python_release.subprocess, "run", side_effect=run) as commands:
            with patch.object(python_release, "smoke_install") as smoke:
                python_release.build(output, VERSION, self.root)
        self.assertEqual(commands.call_count, 2)
        self.assertEqual(commands.call_args.args[0][1:5], ["-m", "twine", "check", "--strict"])
        smoke.assert_called_once_with(output / WHEEL, VERSION)


class RegistryTests(ReleaseFixture):
    def test_first_publication_copies_both_artifacts(self):
        upload = self.root / "upload"
        with patch.object(python_release, "registry_release", return_value=None):
            self.assertTrue(python_release.pending(VERSION, self.dist, upload))
        for name in (WHEEL, SOURCE):
            self.assertEqual((upload / name).read_bytes(), (self.dist / name).read_bytes())

    def test_partial_retry_copies_only_missing_artifact(self):
        for existing in (WHEEL, SOURCE):
            with self.subTest(existing=existing):
                upload = self.root / f"upload-{existing}"
                metadata = release_metadata(self.dist, [existing])
                with patch.object(python_release, "registry_release", return_value=metadata):
                    self.assertTrue(python_release.pending(VERSION, self.dist, upload))
                self.assertEqual({path.name for path in upload.iterdir()}, {WHEEL, SOURCE} - {existing})

    def test_complete_release_needs_no_upload_and_verifies(self):
        upload = self.root / "upload"
        with patch.object(python_release, "registry_release", return_value=release_metadata(self.dist)):
            self.assertFalse(python_release.pending(VERSION, self.dist, upload))
            python_release.verify_published(VERSION, self.dist)
        self.assertEqual(list(upload.iterdir()), [])

    def test_verification_requires_both_files(self):
        for metadata in (None, release_metadata(self.dist, [WHEEL]), release_metadata(self.dist, [SOURCE])):
            with self.subTest(metadata=metadata):
                with patch.object(python_release, "registry_release", return_value=metadata):
                    with self.assertRaises(python_release.ReleaseError):
                        python_release.verify_published(VERSION, self.dist, attempts=1)

    def test_verification_waits_for_delayed_visibility_of_exact_original_files(self):
        elapsed = 0

        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds

        def registry_response(version):
            self.assertEqual(version, VERSION)
            # The first real publication remained absent beyond the old
            # 25-second window. Model a lagging API followed by a partial view.
            if elapsed <= 30:
                return None
            if elapsed <= 75:
                return release_metadata(self.dist, [WHEEL])
            return release_metadata(self.dist)

        with patch.object(python_release, "registry_release", side_effect=registry_response) as registry:
            with patch.object(python_release.time, "sleep", side_effect=sleep) as sleeping:
                python_release.verify_published(VERSION, self.dist)
        self.assertEqual(elapsed, 90)
        self.assertEqual(registry.call_count, 7)
        self.assertEqual(sleeping.call_count, 6)
        self.assertTrue(all(call.args == (15,) for call in sleeping.call_args_list))

    def test_verification_exhausts_bounded_retries(self):
        with patch.object(python_release, "registry_release", return_value=None) as registry:
            with patch.object(python_release.time, "sleep") as sleep:
                with self.assertRaisesRegex(python_release.ReleaseError, "missing release files"):
                    python_release.verify_published(VERSION, self.dist)
        self.assertEqual(registry.call_count, 12)
        self.assertEqual(sleep.call_count, 11)
        self.assertEqual(sum(call.args[0] for call in sleep.call_args_list), 165)

    def test_verification_does_not_retry_conflicts_or_registry_errors(self):
        conflict = release_metadata(self.dist)
        conflict["urls"][0]["digests"]["sha256"] = "0" * 64
        for outcome in (conflict, python_release.ReleaseError("PyPI returned HTTP 503")):
            with self.subTest(outcome=outcome):
                with patch.object(python_release, "registry_release", side_effect=[outcome]) as registry:
                    with patch.object(python_release.time, "sleep") as sleep:
                        with self.assertRaises(python_release.ReleaseError):
                            python_release.verify_published(VERSION, self.dist)
                registry.assert_called_once()
                sleep.assert_not_called()

    def test_conflicting_hash_refuses_entire_upload_before_copying(self):
        metadata = release_metadata(self.dist, [WHEEL])
        metadata["urls"][0]["digests"]["sha256"] = "0" * 64
        upload = self.root / "upload"
        with patch.object(python_release, "registry_release", return_value=metadata):
            with self.assertRaisesRegex(python_release.ReleaseError, "different bytes"):
                python_release.pending(VERSION, self.dist, upload)
        self.assertFalse(upload.exists())

    def test_rejects_unexpected_duplicate_yanked_or_invalid_registry_files(self):
        variants = []
        unexpected = release_metadata(self.dist)
        unexpected["urls"][0]["filename"] = "other.whl"
        variants.append(unexpected)
        duplicate = release_metadata(self.dist)
        duplicate["urls"].append(duplicate["urls"][0])
        variants.append(duplicate)
        yanked = release_metadata(self.dist)
        yanked["urls"][0]["yanked"] = True
        variants.append(yanked)
        yanked_release = release_metadata(self.dist)
        yanked_release["info"]["yanked"] = True
        variants.append(yanked_release)
        wrong_type = release_metadata(self.dist)
        wrong_type["urls"][0]["packagetype"] = "sdist"
        variants.append(wrong_type)
        wrong_name = release_metadata(self.dist)
        wrong_name["info"]["name"] = "other"
        variants.append(wrong_name)
        wrong_version = release_metadata(self.dist)
        wrong_version["info"]["version"] = "0.1.0"
        variants.append(wrong_version)
        variants.extend([{}, {"info": []}, {"info": {"name": "dialcache", "version": VERSION}, "urls": []}])
        files = python_release.artifacts(self.dist, VERSION)
        for metadata in variants:
            with self.subTest(metadata=metadata), self.assertRaises(python_release.ReleaseError):
                python_release.missing_artifacts(VERSION, files, metadata)

    def test_only_http_404_means_absent(self):
        for status in (404, 401, 403, 429, 500, 503):
            error = urllib.error.HTTPError("https://pypi.org", status, "error", {}, None)
            self.addCleanup(error.close)
            with (
                self.subTest(status=status),
                patch.object(python_release.urllib.request, "urlopen", side_effect=error),
            ):
                if status == 404:
                    self.assertIsNone(python_release.registry_release(VERSION))
                else:
                    with self.assertRaises(python_release.ReleaseError):
                        python_release.registry_release(VERSION)

    def test_network_and_json_failures_are_not_absence(self):
        with patch.object(
            python_release.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")
        ):
            with self.assertRaises(python_release.ReleaseError):
                python_release.registry_release(VERSION)
        for payload in (b"not json", b"[]"):
            with (
                self.subTest(payload=payload),
                patch.object(python_release.urllib.request, "urlopen", return_value=io.BytesIO(payload)),
            ):
                with self.assertRaises(python_release.ReleaseError):
                    python_release.registry_release(VERSION)

    def test_registry_request_uses_exact_project_version_and_timeout(self):
        metadata = release_metadata(self.dist)
        with patch.object(
            python_release.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(metadata).encode())
        ) as request:
            self.assertEqual(python_release.registry_release(VERSION), metadata)
        self.assertEqual(
            request.call_args.args[0].full_url, f"https://pypi.org/pypi/dialcache/{VERSION}/json"
        )
        self.assertEqual(request.call_args.kwargs["timeout"], 30)


if __name__ == "__main__":
    unittest.main()
