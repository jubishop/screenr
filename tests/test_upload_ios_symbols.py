"""Verify bin/upload-ios-symbols with a simulated sentry-cli, so it runs on any platform."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
# The simulated sentry-cli records its arguments, answers `info` with the configured
# authentication status, and exits as the test configures it.
SENTRY_CLI = """import json, os, sys
with open(os.environ['UPLOAD_EVENTS'], 'a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:] == ['info', '--config-status-json']:
    print(json.dumps({'config': {'org': None, 'project': None, 'url': 'https://sentry.io'},
                      'auth': {'type': os.environ.get('FAKE_AUTH') or None, 'successful': True},
                      'have_dsn': False}, indent=2))
    sys.exit(0)
print(os.environ.get('FAKE_OUTPUT', ''))
sys.exit(int(os.environ.get('FAKE_STATUS', '0')))
"""
ARCHIVE = {"ACTION": "install", "CONFIGURATION": "Release", "PLATFORM_NAME": "iphoneos"}


class UploadIOSSymbolsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr ios symbols ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.events = base / "events.jsonl"
        self.tools = base / "tools"
        self.tools.mkdir()
        self.dsyms = base / "Release-iphoneos"
        self.dsyms.mkdir()
        for name in ("sh", "tr", "grep"):
            (self.tools / name).symlink_to(shutil.which(name))
        cli = self.tools / "sentry-cli"
        cli.write_text("#!" + sys.executable + "\n" + SENTRY_CLI)
        cli.chmod(0o755)
        self.env = {"PATH": str(self.tools), "UPLOAD_EVENTS": str(self.events),
                    "DWARF_DSYM_FOLDER_PATH": str(self.dsyms), "FAKE_AUTH": "token"}

    def upload(self, **extra):
        return subprocess.run([str(SOURCE / "bin/upload-ios-symbols")], env=self.env | extra,
                              text=True, capture_output=True, timeout=60)

    def recorded(self):
        if not self.events.exists():
            return []
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def test_uploads_the_archives_dsyms_to_the_screenr_ios_project(self):
        result = self.upload(**ARCHIVE)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.recorded(), [
            ["info", "--config-status-json"],
            ["debug-files", "upload", "--org", "artisanal-software", "--project", "screenr-ios",
             str(self.dsyms)],
        ])
        self.assertNotIn("warning:", result.stdout)

    def test_does_nothing_outside_a_release_device_archive(self):
        for name, value in (("ACTION", "build"), ("CONFIGURATION", "Debug"),
                            ("PLATFORM_NAME", "iphonesimulator")):
            with self.subTest(**{name: value}):
                result = self.upload(**(ARCHIVE | {name: value}))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("only for Release device archives", result.stdout)
                self.assertNotIn("warning:", result.stdout)
                self.assertEqual(self.recorded(), [])

    def test_warns_and_skips_without_sentry_cli(self):
        (self.tools / "sentry-cli").unlink()
        result = self.upload(**ARCHIVE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning: sentry-cli is not installed", result.stdout)

    def test_warns_and_skips_without_an_auth_token(self):
        result = self.upload(**ARCHIVE, FAKE_AUTH="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning: No Sentry auth token", result.stdout)
        self.assertEqual(self.recorded(), [["info", "--config-status-json"]])

    def test_fails_the_archive_when_an_upload_fails(self):
        result = self.upload(**ARCHIVE, FAKE_STATUS="1", FAKE_OUTPUT="error: API request failed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error: Uploading this archive's symbols to Sentry failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
