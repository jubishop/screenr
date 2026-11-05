"""Verify the iPhone app's shared package cache through bin/ios-packages, with simulated Xcode tools."""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1]
GB = 1024 ** 3
PINS = '{"pins": [{"identity": "sentry-cocoa", "state": {"version": "%s"}}], "version": 3}\n'
# Each simulated tool records its arguments and whether another process held
# each of the cache's locks while it ran, then exits as the test configures it.
# Resolving creates the sources directory, as xcodebuild does.
TOOL = """import fcntl, json, os, sys
from pathlib import Path
cache = Path(os.environ['SCREENR_IOS_PACKAGE_CACHE'])
def held(name):
    descriptor = os.open(cache / name, os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        return True
    finally:
        os.close(descriptor)
arguments = sys.argv[1:]
with open(os.environ['CHECK_EVENTS'], 'a') as stream:
    stream.write(json.dumps({'command': [os.path.basename(sys.argv[0]), *arguments],
                             'resolving': held('resolve.lock'), 'in use': held('users.lock')}) + '\\n')
if '-resolvePackageDependencies' in arguments:
    sources = Path(arguments[arguments.index('-clonedSourcePackagesDirPath') + 1])
    (sources / 'checkouts/sentry-cocoa').mkdir(parents=True, exist_ok=True)
    sys.exit(int(os.environ.get('FAKE_STATUS_RESOLVE', '0')))
sys.exit(int(os.environ.get('FAKE_STATUS', '0')))
"""


class IOSPackagesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr ios packages ")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.repo = self.checkout("checkout", "9.32.0")
        self.cache = self.base / "Caches/screenr-ios-packages"
        self.events = self.base / "events.jsonl"
        tools = self.base / "tools"
        tools.mkdir()
        (tools / "python3").symlink_to(sys.executable)
        for name in ("xcodebuild", "swift"):
            (tools / name).write_text("#!" + sys.executable + "\n" + TOOL)
            (tools / name).chmod(0o755)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("FAKE_") and not key.startswith("GIT_")}
        self.env.update(PATH=str(tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1",
                        SCREENR_IOS_PACKAGE_CACHE=str(self.cache))

    def checkout(self, name, version):
        """A checkout with the package scripts and a Package.resolved that pins this sentry-cocoa version."""
        repo = self.base / name
        (repo / "bin").mkdir(parents=True)
        for script in ("bin/ios-packages", "bin/_ios_packages.py", "bin/_ios_check_records.py"):
            shutil.copy2(SOURCE / script, repo / script)
        (repo / "ios/ScreenrKit").mkdir(parents=True)
        (repo / "ios/ScreenrKit/Package.resolved").write_text(PINS % version)
        return repo

    def run_in(self, repo, *args, **extra):
        return subprocess.run([str(repo / "bin/ios-packages"), *args], cwd=repo, env=self.env | extra, text=True,
                              capture_output=True, timeout=60)

    def recorded(self):
        if not self.events.exists():
            return []
        events = [json.loads(line) for line in self.events.read_text().splitlines()]
        self.events.unlink()
        return events

    def sources(self, events):
        [resolve] = [event for event in events if "-resolvePackageDependencies" in event["command"]]
        arguments = resolve["command"]
        return Path(arguments[arguments.index("-clonedSourcePackagesDirPath") + 1])

    @contextlib.contextmanager
    def holding(self, name, operation):
        """Hold one of the cache's locks, as another command would, until the block ends."""
        self.cache.mkdir(parents=True, exist_ok=True)
        with (self.cache / name).open("w") as lock:
            fcntl.flock(lock, operation | fcntl.LOCK_NB)
            yield

    def big_cache(self, gigabytes):
        """Fill the cache with an old package directory of this apparent size, without writing it."""
        old = self.cache / "sources/0123456789abcdef/artifacts/Sentry.xcframework.zip"
        old.parent.mkdir(parents=True, exist_ok=True)
        with old.open("wb") as stream:
            stream.truncate(int(gigabytes * GB))
        return old

    def test_xcodebuild_runs_against_this_checkouts_packages_after_resolving_them_under_the_lock(self):
        result = self.run_in(self.repo, "xcodebuild", "build", "-scheme", "Screenr", FAKE_STATUS="3")
        # The command's own status is the wrapper's.
        self.assertEqual(result.returncode, 3, result.stderr)
        resolve, build = self.recorded()
        sources = self.sources([resolve])
        packages = ["-clonedSourcePackagesDirPath", str(sources), "-packageCachePath", str(self.cache / "swiftpm"),
                    "-onlyUsePackageVersionsFromResolvedFile"]
        self.assertEqual(resolve, {"command": ["xcodebuild", "-resolvePackageDependencies", "-project",
                                               "ios/Screenr.xcodeproj", *packages],
                                   "resolving": True, "in use": False})
        # The command runs after the lock is released, while this command holds the cache in use.
        self.assertEqual(build, {"command": ["xcodebuild", *packages, "build", "-scheme", "Screenr"],
                                 "resolving": False, "in use": True})
        self.assertTrue(sources.is_relative_to(self.cache / "sources"))
        self.assertFalse(sources.is_relative_to(self.repo))

    def test_checkouts_with_the_same_package_resolved_share_one_copy_of_the_sources(self):
        other = self.checkout("other", "9.32.0")
        updated = self.checkout("updated", "9.33.0")
        found = {}
        for repo in (self.repo, other, updated):
            result = self.run_in(repo, "xcodebuild", "build")
            self.assertEqual(result.returncode, 0, result.stderr)
            found[repo.name] = self.sources(self.recorded())
        self.assertEqual(found["checkout"], found["other"])
        # A different Package.resolved gets its own directory, so a checkout on
        # either version never changes the sources another one builds against.
        self.assertNotEqual(found["checkout"], found["updated"])
        self.assertEqual(found["checkout"].parent, found["updated"].parent)

    def test_swift_uses_the_shared_download_cache_without_resolving_xcodes_copy(self):
        result = self.run_in(self.repo, "swift", "test", "--package-path", "ios/ScreenrKit", "--scratch-path",
                             "ios/build/ScreenrKit", "--filter", "AppConfigurationTests")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [
            {"command": ["swift", "test", "--cache-path", str(self.cache / "swiftpm"), "--package-path",
                         "ios/ScreenrKit", "--scratch-path", "ios/build/ScreenrKit", "--filter",
                         "AppConfigurationTests"],
             "resolving": False, "in use": True}])

    def test_a_failed_resolution_stops_before_the_command(self):
        result = self.run_in(self.repo, "xcodebuild", "build", FAKE_STATUS_RESOLVE="74")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Package resolution failed with status 74", result.stderr)
        self.assertEqual(len(self.recorded()), 1)

    def test_a_cache_past_12_gb_is_deleted_and_resolved_again(self):
        old = self.big_cache(12.5)
        download = self.cache / "swiftpm/artifacts/old.zip"
        download.parent.mkdir(parents=True)
        download.write_text("an older release's frameworks")
        result = self.run_in(self.repo, "xcodebuild", "build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Deleting the shared iOS package cache in {self.cache}: it holds 12.5 GB, over its "
                      "12 GB limit.", result.stdout)
        self.assertFalse(old.exists())
        self.assertFalse(download.exists())
        # Its locks stay, and this checkout's packages are resolved again.
        self.assertEqual(sorted(path.name for path in self.cache.glob("*.lock")), ["resolve.lock", "users.lock"])
        self.assertTrue((self.sources(self.recorded()) / "checkouts/sentry-cocoa").is_dir())

    def test_a_cache_within_12_gb_is_kept(self):
        old = self.big_cache(11.9)
        result = self.run_in(self.repo, "xcodebuild", "build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Deleting", result.stdout)
        self.assertTrue(old.exists())

    def test_a_cache_past_12_gb_is_kept_while_another_command_uses_it(self):
        old = self.big_cache(13)
        with self.holding("users.lock", fcntl.LOCK_SH):
            result = self.run_in(self.repo, "xcodebuild", "build")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"The shared iOS package cache in {self.cache} holds 13.0 GB, over its 12 GB limit, but "
                      "another command is using it; a later one will delete it.", result.stdout)
        self.assertTrue(old.exists())
        self.assertEqual(len(self.recorded()), 2)

    def test_waits_while_another_command_resolves_packages(self):
        with self.holding("resolve.lock", fcntl.LOCK_EX):
            process = subprocess.Popen([str(self.repo / "bin/ios-packages"), "xcodebuild", "build"], cwd=self.repo,
                                       env=self.env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.addCleanup(lambda: process.poll() is None and process.kill())
            self.assertEqual(process.stdout.readline(),
                             f"Waiting for the shared iOS package cache in {self.cache}: another command is "
                             "resolving packages into it or deleting it.\n")
            time.sleep(0.5)
            self.assertIsNone(process.poll())
            self.assertEqual(self.recorded(), [])
        output, error = process.communicate(timeout=30)
        self.assertEqual(process.returncode, 0, error)
        self.assertEqual(len(self.recorded()), 2)

    def test_accepts_only_xcodebuild_and_swift(self):
        for args in ((), ("make", "build"), ("swift",)):
            with self.subTest(args=args):
                result = self.run_in(self.repo, *args)
                self.assertEqual(result.returncode, 2)
                self.assertIn("usage: bin/ios-packages xcodebuild|swift", result.stderr)
        self.assertEqual(self.recorded(), [])


if __name__ == "__main__":
    unittest.main()
