"""Verify bin/check-ios with simulated Xcode tools, so it runs on any platform."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1]
APP_INTENTS_NOTICE = ("2026-10-13 16:01:06.345 appintentsmetadataprocessor[47552:59012224] warning: "
                      "Metadata extraction skipped, no AppIntents.framework dependency found")
RUNTIMES = {"runtimes": [
    {"platform": "iOS", "isAvailable": True, "version": "26.4", "name": "iOS 26.4",
     "identifier": "runtime-26-4", "supportedDeviceTypes": [
         {"name": "iPhone 17 Pro", "productFamily": "iPhone", "identifier": "iphone-17-pro"}]},
    {"platform": "iOS", "isAvailable": True, "version": "27.0", "name": "iOS 27.0",
     "identifier": "runtime-27-0", "supportedDeviceTypes": [
         {"name": "iPad Pro", "productFamily": "iPad", "identifier": "ipad-pro"},
         {"name": "iPhone 18 Pro", "productFamily": "iPhone", "identifier": "iphone-18-pro"},
         {"name": "iPhone 18 Pro Max", "productFamily": "iPhone", "identifier": "iphone-18-pro-max"}]},
    {"platform": "iOS", "isAvailable": False, "version": "28.0", "name": "iOS 28.0",
     "identifier": "runtime-28-0", "supportedDeviceTypes": []},
    {"platform": "watchOS", "isAvailable": True, "version": "30.0", "name": "watchOS 30.0",
     "identifier": "runtime-watch", "supportedDeviceTypes": []},
]}
# Each simulated tool records its arguments and whether it saw SDKROOT, then
# prints and exits as the test configures it.
RECORD = """import json, os, sys
from pathlib import Path
def record(*event):
    with open(os.environ['CHECK_EVENTS'], 'a') as stream:
        stream.write(json.dumps([*event, 'SDKROOT' in os.environ]) + '\\n')
def finish(step):
    print(os.environ.get('FAKE_OUTPUT_' + step, ''))
    sys.exit(int(os.environ.get('FAKE_STATUS_' + step, '0')))
"""
XCODEBUILD = RECORD + """
if sys.argv[1:] == ['-version']:
    print(os.environ.get('FAKE_XCODE_VERSION', 'Xcode 27.0\\nBuild version 27A266a'))
    sys.exit(0)
record('xcodebuild', *sys.argv[1:])
step = sys.argv[-1].upper()
bundle = Path(sys.argv[sys.argv.index('-resultBundlePath') + 1])
bundle.mkdir(parents=True)
(bundle / 'build.json').write_text(os.environ.get('FAKE_BUILD_RESULTS_' + step, json.dumps(
    {'errorCount': 0, 'warningCount': 0, 'analyzerWarningCount': 0})))
(bundle / 'summary.json').write_text(os.environ.get('FAKE_TEST_SUMMARY', json.dumps(
    {'result': 'Passed', 'passedTests': 6, 'failedTests': 0, 'skippedTests': 0})))
if os.environ.get('FAKE_HANG_' + step):
    # Hang with a child that ignores SIGTERM, as a stuck test run can, and
    # report both process IDs.
    import signal, subprocess, time
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = subprocess.Popen([sys.executable, '-c', 'import signal, time; '
                              'signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)'])
    print('Testing started', flush=True)
    Path(os.environ['FAKE_HANG_' + step]).write_text(f'{os.getpid()} {child.pid}')
    time.sleep(600)
finish(step)
"""
XCRUN = RECORD + """
arguments = sys.argv[1:]
if arguments[:2] == ['simctl', 'list']:
    print(os.environ['FAKE_RUNTIMES'])
elif arguments[:2] == ['simctl', 'create']:
    record('xcrun', *arguments)
    print('NEW-UDID')
elif arguments[:2] == ['simctl', 'bootstatus']:
    record('xcrun', *arguments)
    finish('BOOTSTATUS')
elif arguments[0] == 'simctl':
    record('xcrun', *arguments)
elif arguments[:3] == ['xcresulttool', 'get', 'build-results']:
    print((Path(arguments[-1]) / 'build.json').read_text())
elif arguments[:4] == ['xcresulttool', 'get', 'test-results', 'summary']:
    print((Path(arguments[-1]) / 'summary.json').read_text())
else:
    sys.exit('unexpected xcrun ' + ' '.join(arguments))
"""
SWIFT = RECORD + """
record('swift', *sys.argv[1:])
finish('SWIFT')
"""


class CheckIOSTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr ios checks ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.repo = base / "checkout"
        (self.repo / "bin").mkdir(parents=True)
        for name in ("bin/check-ios", "bin/_ios_check_records.py"):
            shutil.copy2(SOURCE / name, self.repo / name)
        self.events = base / "events.jsonl"
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        for name, body in (("xcodebuild", XCODEBUILD), ("xcrun", XCRUN), ("swift", SWIFT)):
            self.tool(name, body)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("FAKE_") and not key.startswith("GIT_")}
        self.env.update(PATH=str(self.tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1",
                        FAKE_RUNTIMES=json.dumps(RUNTIMES),
                        SDKROOT="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform")

    def tool(self, name, body):
        path = self.tools / name
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def check(self, *args, **extra):
        return subprocess.run([str(self.repo / "bin/check-ios"), *args], cwd=self.repo, env=self.env | extra,
                              text=True, capture_output=True, timeout=60)

    def recorded(self):
        events = [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []
        self.assertFalse(any(event[-1] for event in events), "tools must not inherit SDKROOT")
        return [event[:-1] for event in events]

    def steps(self):
        return [event[0] if event[0] != "xcrun" else " ".join(event[1:3]) for event in self.recorded()]

    def test_runs_package_tests_a_release_build_then_simulator_tests_on_its_own_simulator(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("iOS checks passed with no warnings", result.stdout)
        build = str(self.repo / "ios/build")
        events = self.recorded()
        self.assertEqual(events[0], ["swift", "test", "--package-path", "ios/ScreenrKit",
                                     "--scratch-path", build + "/ScreenrKit"])
        project = ["-hideShellScriptEnvironment", "-project", "ios/Screenr.xcodeproj", "-scheme", "Screenr",
                   "-derivedDataPath", build + "/DerivedData"]
        self.assertEqual(events[1], ["xcodebuild", *project, "-configuration", "Release", "-destination",
                                     "generic/platform=iOS Simulator", "-resultBundlePath",
                                     build + "/check/Release.xcresult", "build"])
        self.assertEqual(events[2][:3], ["xcrun", "simctl", "create"])
        self.assertTrue(events[2][3].startswith("screenr-check-checkout-"))
        self.assertEqual(events[2][4:], ["iphone-18-pro", "runtime-27-0"])
        # A new Simulator finishes its first boot before tests launch the app.
        self.assertEqual(events[3], ["xcrun", "simctl", "bootstatus", "NEW-UDID", "-b"])
        self.assertEqual(events[4], ["xcodebuild", *project, "-configuration", "Debug", "-destination",
                                     "platform=iOS Simulator,id=NEW-UDID", "-parallel-testing-enabled", "NO",
                                     # A failure reports at once instead of gathering a sysdiagnose.
                                     "-collect-test-diagnostics", "never",
                                     "-resultBundlePath", build + "/check/Tests.xcresult", "test"])
        self.assertEqual(events[5:], [["xcrun", "simctl", "shutdown", "NEW-UDID"],
                                      ["xcrun", "simctl", "delete", "NEW-UDID"]])

    def test_uses_a_given_simulator_and_leaves_it_in_place(self):
        result = self.check("--simulator", "MY-UDID")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.steps(), ["swift", "xcodebuild", "simctl bootstatus", "xcodebuild"])
        self.assertEqual(self.recorded()[2], ["xcrun", "simctl", "bootstatus", "MY-UDID", "-b"])
        self.assertIn("platform=iOS Simulator,id=MY-UDID", self.recorded()[-1])

    def test_a_failed_boot_still_deletes_its_simulator(self):
        result = self.check(FAKE_STATUS_BOOTSTATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Simulator boot failed with status 1", result.stderr)
        self.assertEqual(self.steps()[-3:], ["simctl bootstatus", "simctl shutdown", "simctl delete"])

    def test_fails_on_a_warning_line_and_still_deletes_its_simulator(self):
        warning = "/checkout/ios/Screenr/App.swift:3:7: warning: variable 'x' was never used"
        result = self.check(FAKE_OUTPUT_TEST="Compiling\n" + warning)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(warning, result.stderr)
        self.assertIn("Simulator tests reported 1 warning(s)", result.stderr)
        self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def test_fails_on_a_package_test_warning_before_building(self):
        result = self.check(FAKE_OUTPUT_SWIFT="ld: warning: duplicate library")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ScreenrKit tests reported 1 warning(s)", result.stderr)
        self.assertEqual(self.steps(), ["swift"])

    def test_the_app_intents_extraction_notice_is_not_a_warning(self):
        result = self.check(FAKE_OUTPUT_BUILD=APP_INTENTS_NOTICE, FAKE_OUTPUT_TEST=APP_INTENTS_NOTICE)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fails_on_an_error_status_and_shows_the_log_tail(self):
        result = self.check(FAKE_OUTPUT_SWIFT="error: no such module", FAKE_STATUS_SWIFT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error: no such module", result.stderr)
        self.assertIn("ScreenrKit tests failed with status 1", result.stderr)
        self.assertEqual(self.steps(), ["swift"])

    def test_fails_when_the_result_bundle_counts_warnings(self):
        counts = json.dumps({"errorCount": 0, "warningCount": 1, "analyzerWarningCount": 0})
        result = self.check(FAKE_BUILD_RESULTS_BUILD=counts)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Release build: warningCount is 1", result.stderr)
        self.assertNotIn("simctl create", self.steps())

    def test_fails_unless_tests_ran_and_none_failed_or_were_skipped(self):
        for summary, message in (
                ({"result": "Failed", "passedTests": 5, "failedTests": 1, "skippedTests": 0},
                 "the result is Failed with 1 failed test(s)"),
                ({"result": "Passed", "passedTests": 5, "failedTests": 0, "skippedTests": 1},
                 "1 test(s) were skipped"),
                ({"result": "Passed", "passedTests": 0, "failedTests": 0, "skippedTests": 0},
                 "no tests passed")):
            with self.subTest(message=message):
                self.events.unlink(missing_ok=True)
                result = self.check(FAKE_TEST_SUMMARY=json.dumps(summary))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Simulator tests: " + message, result.stderr)
                self.assertEqual(self.steps()[-1], "simctl delete")

    def assert_stopped(self, pids):
        """Require that the hung xcodebuild and its child have exited."""
        for pid in pids.read_text().split():
            deadline = time.monotonic() + 5
            while True:
                state = subprocess.run(["ps", "-o", "stat=", "-p", pid], capture_output=True, text=True)
                if state.returncode or state.stdout.strip().startswith("Z"):
                    break
                self.assertLess(time.monotonic(), deadline, f"process {pid} is still running")
                time.sleep(0.05)

    def test_a_hung_test_run_is_stopped_with_its_processes_and_its_simulator_deleted(self):
        pids = self.events.parent / "hung.pids"
        started = time.monotonic()
        result = self.check("--test-timeout", "0.05", FAKE_HANG_TEST=str(pids))
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(time.monotonic() - started, 40)
        self.assertIn("Testing started", result.stderr)
        self.assertIn("Simulator tests: stopped after 0.05 minutes without finishing", result.stderr)
        self.assert_stopped(pids)
        self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def test_stopping_the_check_stops_its_test_run_and_deletes_its_simulator(self):
        for stop in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=stop.name):
                self.events.unlink(missing_ok=True)
                pids = self.events.parent / f"{stop.name}.pids"
                process = subprocess.Popen([str(self.repo / "bin/check-ios")], cwd=self.repo,
                                           env=self.env | {"FAKE_HANG_TEST": str(pids)}, text=True,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                deadline = time.monotonic() + 30
                while not (pids.exists() and pids.read_text()):
                    self.assertLess(time.monotonic(), deadline, "the test run never started")
                    time.sleep(0.05)
                process.send_signal(stop)
                _, error = process.communicate(timeout=30)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn("bin/check-ios stopped", error)
                self.assert_stopped(pids)
                self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def test_requires_xcode_27_and_an_ios_27_runtime(self):
        result = self.check(FAKE_XCODE_VERSION="Xcode 26.4\nBuild version 17E192")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Xcode 27 or later is required", result.stderr)
        self.assertEqual(self.recorded(), [])
        old = {"runtimes": [RUNTIMES["runtimes"][0]]}
        result = self.check(FAKE_RUNTIMES=json.dumps(old))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("An iOS 27 or later Simulator runtime is required", result.stderr)
        (self.tools / "xcodebuild").unlink()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bin/check-ios needs macOS with Xcode 27 or later.", result.stderr)

    def committed_checkout(self):
        """Commit the checkout, with an app and the formatter, to a Git repository."""
        (self.tools / "git").symlink_to(shutil.which("git"))
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        (self.repo / "ios").mkdir()
        (self.repo / "ios/App.swift").write_text("struct App {}\n")
        (self.repo / "bin/format-swift").write_text("#!/bin/sh\n")
        (self.repo / ".gitignore").write_text("/ios/build/\n")
        for args in (("init", "--quiet", "--initial-branch=main"), ("add", "--all"),
                     ("-c", "user.name=Check", "-c", "user.email=check@example.invalid", "commit",
                      "--quiet", "--message", "Main")):
            subprocess.run(["git", *args], cwd=self.repo, env=self.env, check=True, capture_output=True)

    def test_a_pass_on_committed_files_is_recorded_and_reused_with_the_same_xcode(self):
        self.committed_checkout()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Recorded this pass for these iOS files", result.stdout)
        [record] = (self.repo / ".git/screenr-ios-checks").glob("*.json")
        self.assertEqual(json.loads(record.read_text())["xcode"], "Xcode 27.0 Build version 27A266a")
        self.events.unlink()
        # Markdown under ios/ is not an iOS file, committed or not.
        (self.repo / "ios/Notes.md").write_text("Draft notes.\n")
        result = self.check("--reuse")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("iOS checks already passed for these iOS files with Xcode 27.0", result.stdout)
        self.assertEqual(self.recorded(), [])
        # Without --reuse, or with another Xcode, the check runs again.
        for args, extra in (((), {}), (("--reuse",), {"FAKE_XCODE_VERSION": "Xcode 27.1\nBuild version 27B5"})):
            with self.subTest(args=args, extra=extra):
                self.events.unlink(missing_ok=True)
                result = self.check(*args, **extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.steps()[0], "swift")

    def test_a_pass_with_uncommitted_ios_files_is_not_recorded_or_reused(self):
        self.committed_checkout()
        self.assertEqual(self.check().returncode, 0)
        for name in ("ios/App.swift", "ios/Draft.swift", "bin/format-swift"):
            with self.subTest(name=name):
                original = (self.repo / name).read_text() if (self.repo / name).exists() else None
                (self.repo / name).write_text("// draft\n")
                self.events.unlink(missing_ok=True)
                result = self.check("--reuse")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.steps()[0], "swift")
                self.assertIn("This pass is not recorded for reuse", result.stdout)
                if original is None:
                    (self.repo / name).unlink()
                else:
                    (self.repo / name).write_text(original)
        self.assertEqual(len(list((self.repo / ".git/screenr-ios-checks").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
