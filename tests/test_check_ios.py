"""Verify bin/check-ios with simulated Xcode tools, so it runs on any platform."""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from _process_waits import HANG_SECONDS
from test_ios_packages import EXTRACT, data_id, package_artifacts

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
# Variables the tools must not inherit: a macOS SDKROOT, and those that tie Git to
# one repository, such as the GIT_DIR that Git exports to hooks in a linked worktree.
UNWANTED = {"SDKROOT", *subprocess.run(["git", "rev-parse", "--local-env-vars"], check=True,
                                       capture_output=True, text=True).stdout.split()}
# Each simulated tool records its arguments and which of SDKROOT and the GIT_
# variables it saw, then prints and exits as the test configures it.
RECORD = """import json, os, sys
from pathlib import Path
def record(*event):
    seen = sorted(name for name in os.environ if name == 'SDKROOT' or name.startswith('GIT_'))
    with open(os.environ['CHECK_EVENTS'], 'a') as stream:
        stream.write(json.dumps([*event, seen]) + '\\n')
def finish(step):
    print(os.environ.get('FAKE_OUTPUT_' + step, ''))
    sys.exit(int(os.environ.get('FAKE_STATUS_' + step, '0')))
def build_into(option):
    # Leave build output in the directory the option names, as the real tool does,
    # with the package artifacts SwiftPM extracts there.
    output = Path(sys.argv[sys.argv.index(option) + 1])
    output.mkdir(parents=True, exist_ok=True)
    (output / 'built').touch()
    extract(output)
def hang(step):
    # Never return, as Simulator tools can under heavy load, and report the process ID.
    if os.environ.get('FAKE_HANG_' + step):
        import time
        Path(os.environ['FAKE_HANG_' + step]).write_text(str(os.getpid()))
        time.sleep(600)
def hang_with_child(step):
    # Hang with a child that ignores SIGTERM, as a stuck build or test run can, and
    # report both process IDs.
    if os.environ.get('FAKE_HANG_' + step):
        import signal, subprocess, time
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, '-c', 'import signal, time; '
                                  'signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(600)'])
        print(step + ' started', flush=True)
        Path(os.environ['FAKE_HANG_' + step]).write_text(f'{os.getpid()} {child.pid}')
        time.sleep(600)
""" + EXTRACT
XCODEBUILD = RECORD + """
if sys.argv[1:] == ['-version']:
    print(os.environ.get('FAKE_XCODE_VERSION', 'Xcode 27.0\\nBuild version 27A266a'))
    sys.exit(0)
record('xcodebuild', *sys.argv[1:])
if '-resolvePackageDependencies' in sys.argv:
    build_into('-clonedSourcePackagesDirPath')
    finish('RESOLVE')
build_into('-derivedDataPath')
step = sys.argv[-1].upper()
bundle = Path(sys.argv[sys.argv.index('-resultBundlePath') + 1])
bundle.mkdir(parents=True)
(bundle / 'build.json').write_text(os.environ.get('FAKE_BUILD_RESULTS_' + step, json.dumps(
    {'errorCount': 0, 'warningCount': 0, 'analyzerWarningCount': 0})))
(bundle / 'summary.json').write_text(os.environ.get('FAKE_TEST_SUMMARY', json.dumps(
    {'result': 'Passed', 'passedTests': 6, 'failedTests': 0, 'skippedTests': 0})))
if step == 'TEST' and os.environ.get('FAKE_PUSH'):
    # Ask for a push as a UI test does, wait until the check delivers it or
    # gives up, and fail with the check's reason, as PushRelay.swift does.
    import time
    relay = Path(os.environ['TEST_RUNNER_SCREENR_PUSH_RELAY'])
    request = relay / 'friend-request.json'
    (relay / 'friend-request.json.tmp').write_text(os.environ['FAKE_PUSH'])
    (relay / 'friend-request.json.tmp').rename(request)
    def outcome():
        for suffix in ('.sent', '.failed'):
            try:
                return suffix, request.with_suffix(suffix).read_text()
            except FileNotFoundError:
                pass
    # Read the outcome and look for the request the moment the outcome
    # appears, polling often, as a waiting test may.
    deadline = time.monotonic() + 20
    while not (seen := outcome()) and time.monotonic() < deadline:
        time.sleep(0.01)
    suffix, text = seen or (None, None)
    record('delivered', suffix, request.exists(), text)
    if suffix == '.failed':
        print('PushTests.swift:70: error: -[PushTests testAcceptsAFriendRequestFromItsPush] : failed: '
              'xcrun simctl push failed: ' + text)
        sys.exit(65)
if step == 'TEST' and os.environ.get('FAKE_SCREENSHOT'):
    # Take a screenshot as AppStoreScreenshotTests does, where the check says.
    shots = Path(os.environ['TEST_RUNNER_SCREENR_SCREENSHOTS'])
    shots.mkdir(parents=True, exist_ok=True)
    (shots / '1-feed.png').write_text(os.environ['FAKE_SCREENSHOT'])
hang_with_child(step)
finish(step)
"""
XCRUN = RECORD + """
arguments = sys.argv[1:]
if arguments == ['simctl', 'list', '--json', 'devices']:
    hang('DEVICES')
    print(os.environ.get('FAKE_DEVICES', json.dumps({'devices': {}})))
elif arguments[:2] == ['simctl', 'list']:
    print(os.environ['FAKE_RUNTIMES'])
elif arguments[:2] == ['simctl', 'create']:
    record('xcrun', *arguments)
    hang('CREATE')
    print('NEW-UDID')
elif arguments[:2] == ['simctl', 'bootstatus']:
    record('xcrun', *arguments)
    finish('BOOTSTATUS')
elif arguments[:2] == ['simctl', 'push']:
    record('xcrun', *arguments, Path(arguments[-1]).read_text())
    hang('PUSH')
    print("Notification sent to '" + arguments[3] + "'")
elif arguments[0] == 'simctl':
    # shutdown and delete
    record('xcrun', *arguments)
    hang(arguments[1].upper())
    finish(arguments[1].upper())
elif arguments[:3] == ['xcresulttool', 'get', 'build-results']:
    print((Path(arguments[-1]) / 'build.json').read_text())
elif arguments[:4] == ['xcresulttool', 'get', 'test-results', 'summary']:
    hang('SUMMARY')
    print((Path(arguments[-1]) / 'summary.json').read_text())
else:
    sys.exit('unexpected xcrun ' + ' '.join(arguments))
"""
SWIFT = RECORD + """
record('swift', *sys.argv[1:])
build_into('--scratch-path')
hang_with_child('SWIFT')
finish('SWIFT')
"""
# The build-slot wrappers of the owner's Mac, which xcodebuild and swift link
# to. A heavy call, such as a build or a test run, takes a build slot, a flock
# lock in FAKE_BUILD_SLOTS with its holder's process ID, and then runs the next
# tool of its name on PATH, which inherits the slot's descriptor, named in
# BUILD_SLOT_FD. With FAKE_SLOT_WAIT it first waits that many seconds, saying
# so; with FAKE_SLOT_GIVES_UP it then gives up with status 75 instead. A heavy
# call that inherited a slot's descriptor reuses that slot at once. With
# FAKE_SLOT_FAILS, taking a slot fails, and the call runs its tool without one.
BUILD_SLOTS = RECORD + """
import fcntl, time
name, arguments = os.path.basename(sys.argv[0]), sys.argv[1:]
slots = Path(os.environ['FAKE_BUILD_SLOTS'])
def inherited():
    try:
        held = os.fstat(int(os.environ['BUILD_SLOT_FD']))
    except (KeyError, ValueError, OSError):
        return False
    return any((path.stat().st_dev, path.stat().st_ino) == (held.st_dev, held.st_ino)
               for path in slots.glob('slot-*.lock'))
if name == 'xcodebuild':
    heavy = not {'-version', '-resolvePackageDependencies'}.intersection(arguments)
else:
    heavy = arguments[:1] in (['build'], ['test'])
holders = '\\n  pid 1 since 2026-11-09 16:00:00 PST, unattended: xcodebuild test in /elsewhere'
if heavy and os.environ.get('FAKE_SLOT_FAILS'):
    print(name + ': running without a build slot, since taking one failed: [Errno 13] Permission denied',
          file=sys.stderr, flush=True)
elif heavy and inherited():
    record('build-slots', 'reused', name)
elif heavy:
    if os.environ.get('FAKE_SLOT_WAIT'):
        print(name + ': waiting for one of 2 build slots, held by:' + holders, file=sys.stderr, flush=True)
        time.sleep(float(os.environ['FAKE_SLOT_WAIT']))
    if os.environ.get('FAKE_SLOT_GIVES_UP'):
        print(name + ': gave up after waiting 45m00s for one of 2 build slots, held by:' + holders,
              file=sys.stderr, flush=True)
        sys.exit(75)
    slot = os.open(slots / 'slot-1.lock', os.O_RDWR | os.O_CREAT)
    fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.ftruncate(slot, 0)
    os.write(slot, str(os.getpid()).encode())
    os.set_inheritable(slot, True)
    os.environ['BUILD_SLOT_FD'] = str(slot)
    record('build-slots', 'took', name, *arguments)
for directory in os.environ['PATH'].split(os.pathsep):
    tool = os.path.join(directory, name)
    if (os.path.isfile(tool) and os.access(tool, os.X_OK)
            and os.path.basename(os.path.realpath(tool)) != 'build-slots'):
        os.execv(tool, [tool, *arguments])
sys.exit('no ' + name + ' on PATH besides the wrapper')
"""
# The check loads this sitecustomize when PYTHONPATH names its folder. It holds
# the check's thread for a quarter second after each file the check opens,
# renames, or removes in the push relay folder, so the fake test runner, which
# looks every hundredth of a second, sees each state the folder passes through.
# A look the runner misses can only hide a race, never fail a correct check.
PAUSE_RELAY = """import io, os, sys, time
from pathlib import Path
if Path(sys.argv[0]).name == 'check-ios':
    relay = os.environ['PAUSE_PUSH_RELAY']
    def in_relay(argument):
        return (isinstance(argument, (str, os.PathLike))
                and os.path.dirname(os.path.abspath(argument)) == relay)
    def pausing(change):
        def change_then_pause(*arguments, **keywords):
            result = change(*arguments, **keywords)
            if any(in_relay(argument) for argument in arguments):
                time.sleep(0.25)
            return result
        return change_then_pause
    io.open = pausing(io.open)
    for name in ('open', 'rename', 'replace', 'remove', 'unlink'):
        setattr(os, name, pausing(getattr(os, name)))
"""
PINS = """{
  "pins" : [
    {
      "identity" : "sentry-cocoa",
      "state" : { "version" : "%s" }
    }
  ],
  "version" : 3
}
"""


def default_interrupt():
    """Give a child the default SIGINT handling, which an ignored SIGINT in this suite's parent would replace."""
    signal.signal(signal.SIGINT, signal.SIG_DFL)

class CheckIOSTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr ios checks ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.repo = base / "checkout"
        (self.repo / "bin").mkdir(parents=True)
        for name in ("bin/check-ios", "bin/_build_slot.py", "bin/_ios_check_records.py", "bin/_ios_packages.py"):
            shutil.copy2(SOURCE / name, self.repo / name)
        self.events = base / "events.jsonl"
        # The check's machine-wide slots, kept apart from real checks on this Mac.
        self.slots = base / "slots"
        self.slots.mkdir()
        # The Mac's shared package cache, kept apart from the real one.
        self.cache = base / "Caches/screenr-ios-packages"
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        for name, body in (("xcodebuild", XCODEBUILD), ("xcrun", XCRUN), ("swift", SWIFT)):
            self.tool(name, body)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("FAKE_") and not key.startswith("GIT_")}
        self.env.update(PATH=str(self.tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1",
                        FAKE_RUNTIMES=json.dumps(RUNTIMES), SCREENR_CHECK_IOS_SLOT_DIR=str(self.slots),
                        SCREENR_IOS_PACKAGE_CACHE=str(self.cache),
                        SDKROOT="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform")

    def tool(self, name, body):
        path = self.tools / name
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def check(self, *args, **extra):
        return subprocess.run([str(self.repo / "bin/check-ios"), *args], cwd=self.repo, env=self.env | extra,
                              text=True, capture_output=True, timeout=HANG_SECONDS)

    def pausing_the_relay(self):
        """Return the environment that holds the check's push relay after each change it makes to the folder."""
        site = self.events.parent / "site"
        site.mkdir()
        (site / "sitecustomize.py").write_text(PAUSE_RELAY)
        return {"PYTHONPATH": str(site), "PAUSE_PUSH_RELAY": str(self.repo / "ios/build/check/push-relay")}

    def recorded(self):
        events = [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []
        leaked = [event for event in events if UNWANTED.intersection(event[-1])]
        self.assertEqual(leaked, [], "tools must not inherit SDKROOT or Git's repository variables")
        return [event[:-1] for event in events]

    def deliveries(self):
        """Return what the fake test runner saw the moment each push's outcome appeared."""
        return [event[1:] for event in self.recorded() if event[0] == "delivered"]

    def steps(self):
        return [event[0] if event[0] != "xcrun" else " ".join(event[1:3]) for event in self.recorded()]

    @contextlib.contextmanager
    def holding_slots(self, *numbers):
        """Hold these check slots, as other checks on the Mac would, until the block ends."""
        with contextlib.ExitStack() as stack:
            for number in numbers:
                slot = stack.enter_context((self.slots / f"screenr-check-ios-slot-{number}.lock").open("w"))
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def test_resolves_packages_then_runs_package_tests_a_release_build_and_simulator_tests_on_its_own_simulator(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("iOS checks passed with no warnings", result.stdout)
        build = str(self.repo / "ios/build")
        events = self.recorded()
        # xcodebuild's package sources and both tools' downloads are in the
        # Mac's shared cache, outside the checkout.
        sources = events[0][events[0].index("-clonedSourcePackagesDirPath") + 1]
        self.assertTrue(Path(sources).is_relative_to(self.cache))
        packages = ["-clonedSourcePackagesDirPath", sources, "-packageCachePath", str(self.cache / "swiftpm"),
                    "-onlyUsePackageVersionsFromResolvedFile"]
        self.assertEqual(events[0], ["xcodebuild", "-resolvePackageDependencies", "-project",
                                     "ios/Screenr.xcodeproj", *packages])
        self.assertEqual(events[1], ["swift", "test", "--package-path", "ios/ScreenrKit",
                                     "--scratch-path", build + "/ScreenrKit", "--cache-path", str(self.cache / "swiftpm")])
        project = ["-hideShellScriptEnvironment", "-project", "ios/Screenr.xcodeproj", "-scheme", "Screenr",
                   "-derivedDataPath", build + "/DerivedData", *packages]
        self.assertEqual(events[2], ["xcodebuild", *project, "-configuration", "Release", "-destination",
                                     "generic/platform=iOS Simulator", "-resultBundlePath",
                                     build + "/check/Release.xcresult", "build"])
        self.assertEqual(events[3][:3], ["xcrun", "simctl", "create"])
        self.assertTrue(events[3][3].startswith("screenr-check-checkout-"))
        self.assertEqual(events[3][4:], ["iphone-18-pro", "runtime-27-0"])
        # A new Simulator finishes its first boot before tests launch the app.
        self.assertEqual(events[4], ["xcrun", "simctl", "bootstatus", "NEW-UDID", "-b"])
        # The keyboard's one-time introduction never covers what a test taps.
        self.assertEqual(events[5], ["xcrun", "simctl", "spawn", "NEW-UDID", "defaults", "write",
                                     "com.apple.keyboard.preferences", "DidShowContinuousPathIntroduction",
                                     "-bool", "true"])
        self.assertEqual(events[6], ["xcodebuild", *project, "-configuration", "Debug", "-destination",
                                     "platform=iOS Simulator,id=NEW-UDID", "-parallel-testing-enabled", "NO",
                                     # A failure reports at once instead of gathering a sysdiagnose.
                                     "-collect-test-diagnostics", "never",
                                     "-resultBundlePath", build + "/check/Tests.xcresult", "test"])
        self.assertEqual(events[7:], [["xcrun", "simctl", "shutdown", "NEW-UDID"],
                                      ["xcrun", "simctl", "delete", "NEW-UDID"]])

    def test_keeps_the_app_store_screenshots_the_ui_tests_take_until_its_next_run(self):
        result = self.check(FAKE_SCREENSHOT="feed")
        self.assertEqual(result.returncode, 0, result.stderr)
        shots = self.repo / "ios/build/check/screenshots"
        self.assertEqual((shots / "1-feed.png").read_text(), "feed")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(shots.exists())

    def test_delivers_the_pushes_ui_tests_ask_for_to_its_simulator(self):
        payload = json.dumps({"aps": {"alert": {"body": "New activity on Screenr"}}, "notificationId": "14"})
        result = self.check(FAKE_PUSH=payload, **self.pausing_the_relay())
        self.assertEqual(result.returncode, 0, result.stderr)
        relay = str(self.repo / "ios/build/check/push-relay")
        test_run = next(event for event in self.recorded() if event[-1] == "test")
        self.assertIn("platform=iOS Simulator,id=NEW-UDID", test_run)
        pushes = [event for event in self.recorded() if event[:3] == ["xcrun", "simctl", "push"]]
        self.assertEqual(pushes, [["xcrun", "simctl", "push", "NEW-UDID", "com.artisanalsoftware.Screenr.dev",
                                   relay + "/friend-request.json", payload]])
        # The test saw the delivery: the request became .sent with simctl's
        # output, which was whole, and the request was gone, the moment .sent
        # appeared.
        self.assertEqual(self.deliveries(),
                         [[".sent", False, "Notification sent to 'com.artisanalsoftware.Screenr.dev'\n"]])
        self.assertEqual(sorted(path.name for path in Path(relay).iterdir()), ["friend-request.sent"])

    def test_a_push_simctl_never_sends_fails_its_test_with_the_reason_and_the_check_still_ends(self):
        pid = self.events.parent / "push.pid"
        started = time.monotonic()
        result = self.check(FAKE_PUSH=json.dumps({"aps": {"badge": 3}}), FAKE_HANG_PUSH=str(pid),
                            SCREENR_CHECK_IOS_PUSH_TIMEOUT="0.5", **self.pausing_the_relay())
        self.assertLess(time.monotonic() - started, 30)
        self.assertNotEqual(result.returncode, 0)
        # The test that asked for the push failed with the check's reason for
        # it, which was whole, and the request was gone, the moment .failed
        # appeared.
        reason = "it did not finish within 0.5 seconds, so bin/check-ios stopped it\n"
        self.assertEqual(self.deliveries(), [[".failed", False, reason]])
        self.assertIn("xcrun simctl push failed: " + reason.strip(), result.stderr)
        self.assertIn("Simulator tests failed with status 65", result.stderr)
        self.assert_stopped(pid)
        self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def test_uses_a_given_simulator_and_leaves_it_in_place(self):
        result = self.check("--simulator", "MY-UDID")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.steps(), ["xcodebuild", "swift", "xcodebuild", "simctl bootstatus", "simctl spawn",
                                        "xcodebuild"])
        self.assertEqual(self.recorded()[3], ["xcrun", "simctl", "bootstatus", "MY-UDID", "-b"])
        self.assertEqual(self.recorded()[4][:4], ["xcrun", "simctl", "spawn", "MY-UDID"])
        self.assertIn("platform=iOS Simulator,id=MY-UDID", self.recorded()[-1])

    def test_a_failed_package_resolution_stops_before_the_package_tests(self):
        result = self.check(FAKE_OUTPUT_RESOLVE="xcodebuild: error: an out-of-date resolved file was detected",
                            FAKE_STATUS_RESOLVE="74")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("an out-of-date resolved file was detected", result.stderr)
        self.assertIn("Package resolution failed with status 74", result.stderr)
        self.assertEqual(self.steps(), ["xcodebuild"])

    def test_deletes_a_shared_package_cache_past_12_gb_before_resolving_again(self):
        # Several releases' frameworks, at an apparent 12.5 GB that takes no disk.
        old = self.cache / "sources/0123456789abcdef/artifacts/Sentry.xcframework.zip"
        old.parent.mkdir(parents=True)
        with old.open("wb") as stream:
            stream.truncate(int(12.5 * 1024 ** 3))
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Deleting the shared iOS package cache in {self.cache}: it holds 12.5 GB", result.stdout)
        self.assertFalse(old.exists())
        self.assertEqual(self.steps()[:2], ["xcodebuild", "swift"])

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
        self.assertEqual(self.steps(), ["xcodebuild", "swift"])

    def test_the_app_intents_extraction_notice_is_not_a_warning(self):
        result = self.check(FAKE_OUTPUT_BUILD=APP_INTENTS_NOTICE, FAKE_OUTPUT_TEST=APP_INTENTS_NOTICE)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fails_on_an_error_status_and_shows_the_log_tail(self):
        result = self.check(FAKE_OUTPUT_SWIFT="error: no such module", FAKE_STATUS_SWIFT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error: no such module", result.stderr)
        self.assertIn("ScreenrKit tests failed with status 1", result.stderr)
        self.assertEqual(self.steps(), ["xcodebuild", "swift"])

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

    def test_builds_against_other_package_sources_start_over(self):
        # A checkout's builds from before the shared cache used xcodebuild's
        # own copy of the sources in ios/build/DerivedData/SourcePackages.
        build = self.repo / "ios/build"
        own_copy = build / "DerivedData/SourcePackages/artifacts/sentry-cocoa"
        for cache, kept in ((self.cache, False), (self.cache, True), (self.cache.parent / "moved", False)):
            with self.subTest(cache=cache.name, kept=kept):
                own_copy.mkdir(parents=True, exist_ok=True)
                result = self.check(SCREENR_IOS_PACKAGE_CACHE=str(cache))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(own_copy.exists(), kept)
                self.assertEqual("Removing ios/build/ScreenrKit and ios/build/DerivedData" in result.stdout,
                                 not kept)

    @unittest.skipUnless(sys.platform == "darwin", "APFS clones need macOS")
    def test_its_package_tests_copy_of_the_package_artifacts_shares_the_caches_files(self):
        template = package_artifacts(self.events.parent / "download")
        result = self.check(FAKE_ARTIFACTS=str(template))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("of SwiftPM's package artifacts in this checkout now share", result.stdout)
        events = self.recorded()
        sources = Path(events[0][events[0].index("-clonedSourcePackagesDirPath") + 1])
        name = "artifacts/sentry-cocoa/Sentry/Sentry.xcframework/Info.plist"
        self.assertEqual(data_id(self.repo / "ios/build/ScreenrKit" / name), data_id(sources / name))

    def test_holds_the_shared_package_cache_in_use_until_it_exits(self):
        pids = self.events.parent / "hung.pids"
        check = self.start(FAKE_HANG_TEST=str(pids))
        deadline = time.monotonic() + 30
        while not (pids.exists() and pids.read_text()):
            self.assertLess(time.monotonic(), deadline, "the test run never started")
            time.sleep(0.05)

        def deletable():
            with (self.cache / "users.lock").open("w") as users:
                try:
                    fcntl.flock(users, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return True
                except BlockingIOError:
                    return False
        # While its Simulator tests run, nothing can delete the cache.
        self.assertFalse(deletable())
        check.send_signal(signal.SIGTERM)
        check.communicate(timeout=HANG_SECONDS)
        self.assertTrue(deletable())

    def test_a_package_update_rebuilds_the_package_and_derived_data_from_scratch(self):
        # A sentry-cocoa update replaced its framework's headers in both
        # directories, and modules built before it then failed to load.
        build = self.repo / "ios/build"
        previous = [build / "ScreenrKit/out/Sentry.framework", build / "DerivedData/Build/Sentry.framework"]
        resolved = self.repo / "ios/ScreenrKit/Package.resolved"
        resolved.parent.mkdir(parents=True)
        for version, kept in (
                # Output from before the check recorded its packages may be from any version.
                ("9.30.1", False),
                # The same packages keep the last run's output to build on.
                ("9.30.1", True),
                ("9.32.0", False)):
            with self.subTest(version=version, kept=kept):
                resolved.write_text(PINS % version)
                for path in previous:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("from the previous run")
                result = self.check()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([path.exists() for path in previous], [kept, kept])
                self.assertEqual("Removing ios/build/ScreenrKit and ios/build/DerivedData" in result.stdout,
                                 not kept)
                # The steps built after the check removed the old output.
                self.assertTrue((build / "ScreenrKit/built").exists())
                self.assertTrue((build / "DerivedData/built").exists())

    def assert_stopped(self, pids):
        """Require that a hung fake tool and any child it started have exited."""
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
        self.assertIn("TEST started", result.stderr)
        self.assertIn("Simulator tests: stopped after 0.05 minutes without finishing", result.stderr)
        self.assert_stopped(pids)
        self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def test_hung_package_tests_or_release_build_stop_with_their_processes_at_the_build_limit(self):
        for step, label, steps in (("SWIFT", "ScreenrKit tests", ["xcodebuild", "swift"]),
                                   ("BUILD", "Release build", ["xcodebuild", "swift", "xcodebuild"])):
            with self.subTest(step=label):
                self.events.unlink(missing_ok=True)
                pids = self.events.parent / f"{step}.pids"
                started = time.monotonic()
                result = self.check(SCREENR_CHECK_IOS_BUILD_TIMEOUT="0.05", **{"FAKE_HANG_" + step: str(pids)})
                self.assertLess(time.monotonic() - started, 40)
                self.assertNotEqual(result.returncode, 0)
                # The failure shows the end of the step's log.
                self.assertIn(f"{step} started", result.stderr)
                self.assertIn(f"{label}: stopped after 0.05 minutes without finishing", result.stderr)
                self.assert_stopped(pids)
                self.assertEqual(self.steps(), steps)

    def test_a_hung_tool_call_is_stopped_and_fails_the_check_with_its_command(self):
        bundle = shlex.quote(str(self.repo / "ios/build/check/Tests.xcresult"))
        for step, command, cleanup in (
                # Before the Simulator exists, so there is none to delete.
                ("DEVICES", re.escape("xcrun simctl list --json devices"), []),
                ("CREATE", r"xcrun simctl create screenr-check-checkout-\d+ iphone-18-pro runtime-27-0", []),
                ("SPAWN", re.escape("xcrun simctl spawn NEW-UDID defaults write com.apple.keyboard.preferences "
                                    "DidShowContinuousPathIntroduction -bool true"),
                 ["simctl shutdown", "simctl delete"]),
                ("SUMMARY", re.escape(f"xcrun xcresulttool get test-results summary --path {bundle}"),
                 ["simctl shutdown", "simctl delete"])):
            with self.subTest(step=step):
                self.events.unlink(missing_ok=True)
                pid = self.events.parent / f"{step}.pid"
                started = time.monotonic()
                result = self.check(SCREENR_CHECK_IOS_TOOL_TIMEOUT="2", **{"FAKE_HANG_" + step: str(pid)})
                self.assertLess(time.monotonic() - started, 30)
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr, command + " did not finish within 2 seconds, so bin/check-ios "
                                                          r"stopped it\.")
                self.assert_stopped(pid)
                self.assertNotIn("iOS checks passed", result.stdout)
                self.assertEqual([name for name in self.steps() if name in cleanup], cleanup)

    def test_a_simulator_it_cannot_shut_down_or_delete_is_reported_and_leaves_the_result_alone(self):
        pid = self.events.parent / "cleanup.pid"
        stopped = "did not finish within 2 seconds, so bin/check-ios stopped it."
        left = "Simulator NEW-UDID was not deleted. Delete it with: xcrun simctl delete NEW-UDID"
        for case, extra, passes, reports in (
                ("shutdown hangs", {"FAKE_HANG_SHUTDOWN": str(pid)}, True,
                 [f"xcrun simctl shutdown NEW-UDID {stopped}"]),
                ("delete hangs", {"FAKE_HANG_DELETE": str(pid)}, True,
                 [f"xcrun simctl delete NEW-UDID {stopped}", left]),
                ("delete fails", {"FAKE_STATUS_DELETE": "1", "FAKE_OUTPUT_DELETE": "Invalid device: NEW-UDID"},
                 True, ["xcrun simctl delete NEW-UDID failed with status 1: Invalid device: NEW-UDID", left]),
                # A failed check keeps its own failure.
                ("boot and delete fail", {"FAKE_STATUS_BOOTSTATUS": "1", "FAKE_STATUS_DELETE": "1"}, False,
                 ["Simulator boot failed with status 1", left])):
            with self.subTest(case=case):
                self.events.unlink(missing_ok=True)
                pid.unlink(missing_ok=True)
                started = time.monotonic()
                result = self.check(SCREENR_CHECK_IOS_TOOL_TIMEOUT="2", **extra)
                self.assertLess(time.monotonic() - started, 30)
                self.assertEqual(result.returncode == 0, passes, result.stderr)
                self.assertEqual("iOS checks passed with no warnings" in result.stdout, passes)
                for report in reports:
                    self.assertIn(report, result.stderr)
                if case == "shutdown hangs":
                    # The delete still ran, and it worked.
                    self.assertNotIn("was not deleted", result.stderr)
                if pid.exists():
                    self.assert_stopped(pid)
                self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def ended_process(self):
        """Return the ID of a process that has exited, as a check stopped with SIGKILL has."""
        process = subprocess.Popen([sys.executable, "-c", ""])
        process.wait()
        return process.pid

    def simctl_calls(self):
        """List the check's simctl create, shutdown, and delete calls, with the Simulator each one ended."""
        return [event[2] if event[2] == "create" else " ".join(event[2:4]) for event in self.recorded()
                if event[:2] == ["xcrun", "simctl"] and event[2] in ("create", "shutdown", "delete")]

    def test_deletes_simulators_that_ended_checks_left_behind_and_leaves_every_other_simulator_alone(self):
        left, older = self.ended_process(), self.ended_process()
        devices = {"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                # Left behind by a check whose process has ended, in a checkout whose name ends in a number.
                {"name": f"screenr-check-issue-42-{left}", "udid": "LEFT-BEHIND", "state": "Booted"},
                # A running check's: its process, here this test's, still runs.
                {"name": f"screenr-check-checkout-{os.getpid()}", "udid": "RUNNING", "state": "Booted"},
                # Another user's process, which the check cannot signal, has this ID.
                {"name": "screenr-check-other-1", "udid": "OTHER-USER", "state": "Booted"},
                # No check named these.
                {"name": "iPhone 18 Pro", "udid": "DEFAULT", "state": "Booted"},
                {"name": "screenr-dev", "udid": "DEVELOPMENT", "state": "Shutdown"},
                {"name": "screenr-check-notes", "udid": "NO-PROCESS-ID", "state": "Shutdown"},
                {"name": f"other-project-check-{left}", "udid": "OTHER-PROJECT", "state": "Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
                {"name": f"screenr-check-checkout-{older}", "udid": "OLDER", "state": "Shutdown"}]}}
        result = self.check(FAKE_DEVICES=json.dumps(devices))
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, udid, pid in ((f"screenr-check-issue-42-{left}", "LEFT-BEHIND", left),
                                (f"screenr-check-checkout-{older}", "OLDER", older)):
            self.assertIn(f"Deleted Simulator {name} ({udid}), which an earlier check left behind: "
                          f"its process {pid} has ended.", result.stdout)
        # It deletes them before it creates its own, and its own at the end.
        self.assertEqual(self.simctl_calls(), ["shutdown LEFT-BEHIND", "delete LEFT-BEHIND", "shutdown OLDER",
                                               "delete OLDER", "create", "shutdown NEW-UDID", "delete NEW-UDID"])

    def test_a_left_behind_simulator_it_cannot_delete_is_reported_and_the_check_goes_on(self):
        pid = self.events.parent / "delete.pid"
        devices = {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            {"name": f"screenr-check-checkout-{self.ended_process()}", "udid": "LEFT-BEHIND", "state": "Booted"}]}}
        started = time.monotonic()
        result = self.check(FAKE_DEVICES=json.dumps(devices), FAKE_HANG_DELETE=str(pid),
                            SCREENR_CHECK_IOS_TOOL_TIMEOUT="2")
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("xcrun simctl delete LEFT-BEHIND did not finish within 2 seconds, so bin/check-ios "
                      "stopped it.", result.stderr)
        self.assertIn("Simulator LEFT-BEHIND was not deleted. Delete it with: xcrun simctl delete LEFT-BEHIND",
                      result.stderr)
        self.assertNotIn("Deleted Simulator", result.stdout)
        self.assert_stopped(pid)
        self.assertEqual(self.simctl_calls(), ["shutdown LEFT-BEHIND", "delete LEFT-BEHIND", "create",
                                               "shutdown NEW-UDID", "delete NEW-UDID"])

    def test_stopping_the_check_stops_its_test_run_and_deletes_its_simulator(self):
        for stop in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=stop.name):
                self.events.unlink(missing_ok=True)
                pids = self.events.parent / f"{stop.name}.pids"
                # A shell that starts this suite in the background ignores SIGINT,
                # and children inherit that, so restore its default first.
                process = subprocess.Popen([str(self.repo / "bin/check-ios")], cwd=self.repo,
                                           env=self.env | {"FAKE_HANG_TEST": str(pids)}, text=True,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           preexec_fn=default_interrupt)
                deadline = time.monotonic() + 30
                while not (pids.exists() and pids.read_text()):
                    self.assertLess(time.monotonic(), deadline, "the test run never started")
                    time.sleep(0.05)
                process.send_signal(stop)
                _, error = process.communicate(timeout=HANG_SECONDS)
                self.assertNotEqual(process.returncode, 0)
                self.assertIn("bin/check-ios stopped", error)
                self.assert_stopped(pids)
                self.assertEqual(self.steps()[-2:], ["simctl shutdown", "simctl delete"])

    def start(self, **extra):
        """Start a check in the background, and stop it if the test ends first."""
        process = subprocess.Popen([str(self.repo / "bin/check-ios")], cwd=self.repo, env=self.env | extra,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   preexec_fn=default_interrupt)

        def stop():
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=HANG_SECONDS)
        self.addCleanup(stop)
        return process

    def test_waits_for_a_free_slot_and_holds_its_own_until_it_exits(self):
        pids = self.events.parent / "hung.pids"
        # Other checks hold slots 1 and 3, so the first check here takes slot 2
        # and holds it through its hung test run.
        with self.holding_slots(1, 3):
            first = self.start(FAKE_HANG_TEST=str(pids))
            self.assertEqual(first.stdout.readline(), "Took iOS check slot 2 of 3.\n")
            deadline = time.monotonic() + 30
            while not (pids.exists() and pids.read_text()):
                self.assertLess(time.monotonic(), deadline, "the first check's test run never started")
                time.sleep(0.05)
            second = self.start(CHECK_EVENTS=str(self.events.parent / "second.jsonl"))
            self.assertEqual(second.stdout.readline(), "Waiting for an iOS check slot: all 3 are in use "
                                                       "by other bin/check-ios runs on this Mac.\n")
            first.send_signal(signal.SIGTERM)
            first.communicate(timeout=HANG_SECONDS)
            output, error = second.communicate(timeout=HANG_SECONDS)
        self.assertEqual(second.returncode, 0, error)
        # It took the first check's slot before it started its first step.
        lines = output.splitlines()
        self.assertRegex(lines[0], r"^Took iOS check slot 2 of 3 after waiting \d+\.\d minutes\.$")
        self.assertEqual(lines[1], "==> Package resolution")
        self.assertIn("iOS checks passed with no warnings", output)

    def with_build_slot_wrappers(self):
        """Put build-slot wrappers of xcodebuild and swift ahead of the simulated tools on PATH, as on the owner's Mac."""
        wrappers = self.events.parent / "wrappers"
        wrappers.mkdir()
        (wrappers / "build-slots").write_text("#!" + sys.executable + "\n" + BUILD_SLOTS)
        (wrappers / "build-slots").chmod(0o755)
        for name in ("xcodebuild", "swift"):
            (wrappers / name).symlink_to("build-slots")
        self.build_slots = self.events.parent / "build-slots"
        self.build_slots.mkdir()
        self.env.update(PATH=f"{wrappers}{os.pathsep}{self.tools}", FAKE_BUILD_SLOTS=str(self.build_slots))

    def test_takes_one_build_slot_before_its_first_build_and_runs_every_build_and_test_under_it(self):
        self.with_build_slot_wrappers()
        waiting = "xcodebuild: waiting for one of 2 build slots, held by:\n  pid 1 since"
        # An unattended run can wait for a slot; an interactive one never does.
        for case, extra in (("after a wait", {"FAKE_SLOT_WAIT": "1"}), ("at once", {})):
            with self.subTest(case=case):
                self.events.unlink(missing_ok=True)
                result = self.check(**extra)
                self.assertEqual(result.returncode, 0, result.stderr)
                # It takes one slot after resolving packages, which needs none,
                # and before its first build. Its builds and tests reuse it, and
                # it creates and boots its Simulator while it holds it.
                self.assertEqual(self.steps(), ["xcodebuild", "build-slots", "build-slots", "swift", "build-slots",
                                                "xcodebuild", "simctl create", "simctl bootstatus", "simctl spawn",
                                                "build-slots", "xcodebuild", "simctl shutdown", "simctl delete"])
                self.assertEqual([event for event in self.recorded() if event[0] == "build-slots"],
                                 [["build-slots", "took", "xcodebuild", "bin/check-ios"],
                                  ["build-slots", "reused", "swift"], ["build-slots", "reused", "xcodebuild"],
                                  ["build-slots", "reused", "xcodebuild"]])
                lines = result.stdout.splitlines()
                self.assertLess(lines.index("==> Package resolution"),
                                lines.index("Took a Mac build slot for the rest of the check."))
                self.assertLess(lines.index("Took a Mac build slot for the rest of the check."),
                                lines.index("==> ScreenrKit tests"))
                # The wrapper said it was waiting to the check itself, before any
                # step and its time limit started, and no step waited.
                self.assertEqual(result.stderr.count(waiting), 1 if extra else 0)
                logs = list((self.repo / "ios/build/check").glob("*.log"))
                self.assertEqual(len(logs), 5)
                for log in logs:
                    self.assertNotIn("build slot", log.read_text(), log.name)

    def test_a_check_that_gets_no_build_slot_fails_with_the_wrappers_reason_before_building(self):
        self.with_build_slot_wrappers()
        result = self.check(FAKE_SLOT_WAIT="0.1", FAKE_SLOT_GIVES_UP="1")
        self.assertNotEqual(result.returncode, 0)
        # The wrapper names the slots' holders.
        self.assertIn("xcodebuild: gave up after waiting 45m00s for one of 2 build slots, held by:\n  pid 1 since",
                      result.stderr)
        wrapper = shlex.quote(str(self.events.parent / "wrappers/xcodebuild"))
        self.assertIn(f"bin/check-ios got no Mac build slot: {wrapper} bin/check-ios exited with status 75.",
                      result.stderr)
        # It resolved its packages, but never built or made a Simulator.
        self.assertEqual(self.steps(), ["xcodebuild"])

    def test_runs_without_a_build_slot_when_the_wrapper_cannot_take_one(self):
        self.with_build_slot_wrappers()
        result = self.check(FAKE_SLOT_FAILS="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("xcodebuild: running without a build slot, since taking one failed", result.stderr)
        self.assertNotIn("Took a Mac build slot", result.stdout)
        self.assertEqual(self.steps(), ["xcodebuild", "swift", "xcodebuild", "simctl create", "simctl bootstatus",
                                        "simctl spawn", "xcodebuild", "simctl shutdown", "simctl delete"])

    def test_holds_its_build_slot_until_it_exits(self):
        self.with_build_slot_wrappers()
        pids = self.events.parent / "hung.pids"
        check = self.start(FAKE_HANG_TEST=str(pids))
        deadline = time.monotonic() + 30
        while not (pids.exists() and pids.read_text()):
            self.assertLess(time.monotonic(), deadline, "the test run never started")
            time.sleep(0.05)
        slot = self.build_slots / "slot-1.lock"

        def held():
            with slot.open("a") as stream:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return False
                except BlockingIOError:
                    return True
        # While its Simulator tests run, it holds the slot, and the holder that
        # the slot's record names is one of its own processes.
        self.assertTrue(held())
        parent = subprocess.run(["ps", "-o", "ppid=", "-p", slot.read_text()], capture_output=True, text=True,
                                timeout=HANG_SECONDS)
        self.assertEqual(parent.stdout.strip(), str(check.pid))
        check.send_signal(signal.SIGTERM)
        check.communicate(timeout=HANG_SECONDS)
        # The holder ends with the check, and the slot is free.
        self.assert_stopped(slot)
        self.assertFalse(held())

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
        # Markdown directly in ios/ is not an iOS file, committed or not.
        (self.repo / "ios/Notes.md").write_text("Draft notes.\n")
        # A reused pass needs no slot.
        with self.holding_slots(1, 2, 3):
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
                self.assertEqual(self.steps()[:2], ["xcodebuild", "swift"])

    def test_runs_outside_the_git_repository_that_launched_it(self):
        # Git exports GIT_DIR and its other repository variables to hooks and to
        # git rebase --exec. The check's records and its tools' own Git commands,
        # such as SwiftPM's package checkouts, find their repositories by directory.
        self.committed_checkout()
        other = self.repo.parent / "other"
        subprocess.run(["git", "init", "--quiet", str(other)], env=self.env, check=True, capture_output=True)
        result = self.check(GIT_DIR=str(other / ".git"), GIT_WORK_TREE=str(other),
                            GIT_INDEX_FILE=str(other / ".git/index"), GIT_PREFIX="ios/")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.steps()[:2], ["xcodebuild", "swift"])
        self.assertIn("Recorded this pass for these iOS files", result.stdout)
        self.assertEqual(len(list((self.repo / ".git/screenr-ios-checks").glob("*.json"))), 1)
        self.assertFalse((other / ".git/screenr-ios-checks").exists())

    def test_a_pass_with_uncommitted_ios_files_is_not_recorded_or_reused(self):
        self.committed_checkout()
        self.assertEqual(self.check().returncode, 0)
        # Markdown in a folder under ios/ can be in a SwiftPM target, which warns about it.
        for name in ("ios/App.swift", "ios/Draft.swift", "ios/ScreenrKit/Sources/ScreenrKit/Notes.md",
                     "bin/format-swift"):
            with self.subTest(name=name):
                (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
                original = (self.repo / name).read_text() if (self.repo / name).exists() else None
                (self.repo / name).write_text("// draft\n")
                self.events.unlink(missing_ok=True)
                result = self.check("--reuse")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.steps()[:2], ["xcodebuild", "swift"])
                self.assertIn("This pass is not recorded for reuse", result.stdout)
                if original is None:
                    (self.repo / name).unlink()
                else:
                    (self.repo / name).write_text(original)
        self.assertEqual(len(list((self.repo / ".git/screenr-ios-checks").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
