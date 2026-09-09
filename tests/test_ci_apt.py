"""Exercise the CI source policy with real APT and disposable signed archives."""
from datetime import datetime, timezone
from email.utils import format_datetime
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("apt-get"), "APT policy runs on Ubuntu CI")
class CiAptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.base.chmod(0o755)
        for name in ("etc/apt.conf.d", "etc/sources.list.d", "etc/preferences.d", "state/lists/partial",
                     "cache/archives/partial", "log", "downloads", "keys"):
            (self.base / name).mkdir(parents=True)
        (self.base / "keys").chmod(0o700)
        (self.base / "state/status").touch()
        config = self.base / "sandbox.conf"
        config.write_text("\n".join(
            f'Dir::{key} "{self.base / value}";'
            for key, value in (("Etc", "etc"), ("State", "state"),
                               ("State::status", "state/status"),
                               ("Cache", "cache"), ("Log", "log"))
        ) + '\nAPT::Architecture "amd64";\n')
        self.environment = {**os.environ, "APT_CONFIG": str(config), "LC_ALL": "C"}
        self.requests = []
        self.unavailable = False
        fixture = self

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(fixture.base), **kwargs)

            def do_GET(self):
                fixture.requests.append(self.path)
                if fixture.unavailable:
                    self.send_error(503)
                else:
                    super().do_GET()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.url = f"http://127.0.0.1:{server.server_port}"
        # Hosted CI must exercise the policy installed by the workflow itself.
        policy = (Path("/etc/apt/apt.conf.d/99-screenr-ci")
                  if os.environ.get("GITHUB_ACTIONS") == "true"
                  else ROOT / ".github/ci-apt.conf")
        # With no policy this exercises the previous default APT behavior.
        if policy.exists():
            shutil.copyfile(policy, self.base / "etc/apt.conf.d/99-screenr-ci")
        self.gpg("--passphrase", "", "--quick-generate-key",
                 "Screenr APT fixture <apt@example.invalid>", "ed25519", "sign", "0")
        self.addCleanup(subprocess.run, ["gpgconf", "--homedir", str(self.base / "keys"),
                                        "--kill", "gpg-agent"], check=True)
        self.gpg("--output", str(self.base / "archive-key.gpg"), "--export")
        self.required = self.archive("required", "screenr-required")
        (self.base / "etc/sources.list.d/ubuntu.sources").write_text(
            self.source(self.required))

    def gpg(self, *args):
        subprocess.run(["gpg", "--homedir", str(self.base / "keys"), "--batch", "--yes",
                        *args], check=True, capture_output=True)

    def archive(self, name, package):
        archive = self.base / name
        control = archive / "build/DEBIAN/control"
        control.parent.mkdir(parents=True)
        control.write_text(f"Package: {package}\nVersion: 1.0\nArchitecture: all\n"
                           "Maintainer: Test <apt@example.invalid>\nDescription: APT fixture\n")
        deb = archive / f"{package}.deb"
        subprocess.run(["dpkg-deb", "--build", str(control.parent.parent), str(deb)],
                       check=True, capture_output=True)
        packages = archive / "Packages"
        packages.write_text(control.read_text() + f"Filename: {deb.name}\n"
                            f"Size: {deb.stat().st_size}\n"
                            f"SHA256: {hashlib.sha256(deb.read_bytes()).hexdigest()}\n\n")
        (archive / "Release").write_text(
            "Origin: Screenr fixture\nLabel: Screenr fixture\n"
            f"Date: {format_datetime(datetime.now(timezone.utc))}\n"
            "Architectures: amd64 all\nSHA256:\n"
            f" {hashlib.sha256(packages.read_bytes()).hexdigest()} "
            f"{packages.stat().st_size} Packages\n")
        self.gpg("--output", str(archive / "InRelease"), "--clearsign", str(archive / "Release"))
        return archive

    def source(self, archive):
        return (f"Types: deb\nURIs: {self.url}/{archive.name}\nSuites: ./\n"
                f"Signed-By: {self.base / 'archive-key.gpg'}\n")

    def apt(self, *args):
        return subprocess.run(["apt-get", *args], env=self.environment,
                              cwd=self.base / "downloads", text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout)

    def corrupt(self, path):
        contents = path.read_bytes()
        path.write_bytes(bytes([contents[0] ^ 1]) + contents[1:])

    def test_unrelated_broken_sources_do_not_block_required_packages(self):
        unrelated = self.archive("unrelated", "screenr-unrelated")
        (self.base / "etc/sources.list.d/vendor.sources").write_text(self.source(unrelated))
        legacy = (f"deb [signed-by={self.base / 'archive-key.gpg'}] "
                  f"{self.url}/{unrelated.name} ./\n")
        (self.base / "etc/sources.list").write_text(legacy)
        (self.base / "etc/sources.list.d/vendor.list").write_text(legacy)
        self.corrupt(unrelated / "Packages")
        result = self.apt("update")
        self.assert_success(result)
        self.assertFalse(any(path.startswith("/unrelated/") for path in self.requests))
        self.assert_success(self.apt("download", "screenr-required"))
        self.assertTrue((self.base / "downloads/screenr-required_1.0_all.deb").is_file())

    def test_cached_unrelated_packages_are_not_selectable(self):
        unrelated = self.archive("unrelated", "screenr-unrelated")
        (self.base / "etc/sources.list.d/vendor.sources").write_text(self.source(unrelated))
        # Seed a valid vendor index, as may already exist on a hosted runner.
        self.assert_success(self.apt("-o", "Dir::Etc::sourceparts=sources.list.d", "update"))
        self.assert_success(self.apt("update"))
        result = self.apt("download", "screenr-unrelated")
        self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_required_index_hash_mismatch_fails(self):
        self.corrupt(self.required / "Packages")
        result = self.apt("update")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Hash Sum mismatch", result.stdout)

    def test_required_signature_failure_fails(self):
        signed = self.required / "InRelease"
        signed.write_text(signed.read_text().replace("Origin: Screenr", "Origin: Changed"))
        result = self.apt("update")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("BADSIG", result.stdout)

    def test_required_source_unavailable_fails_even_with_cached_index(self):
        self.assert_success(self.apt("update"))
        # A transient server failure normally only warns and retains the cached index.
        self.unavailable = True
        result = self.apt("-o", "Acquire::Retries=0", "update")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Failed to fetch", result.stdout)

    def test_required_package_failure_is_not_ignored(self):
        self.assert_success(self.apt("update"))
        result = self.apt("install", "--simulate", "screenr-missing")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Unable to locate package", result.stdout)
        self.corrupt(self.required / "screenr-required.deb")
        result = self.apt("download", "screenr-required")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Hash Sum mismatch", result.stdout)


if __name__ == "__main__":
    unittest.main()
