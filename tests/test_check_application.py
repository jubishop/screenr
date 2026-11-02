"""Verify the application checks that bin/check --full runs, with simulated tools, and that CI runs them all."""

import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

SOURCE = Path(__file__).resolve().parents[1]
SCRIPTS = ("format:check", "typecheck", "test", "test:browser")
# A recorded pass for the same iOS files lets bin/check-ios skip itself.
IOS_CHECK = ["check-ios", "--reuse"]
NEXT = {"version": "16.4.2", "resolved": "https://registry.npmjs.org/next/-/next-16.4.2.tgz",
        "integrity": "sha512-next-16.4.2"}
REACT = {"version": "19.3.1", "resolved": "https://registry.npmjs.org/react/-/react-19.3.1.tgz",
         "integrity": "sha512-react-19.3.1"}
# npm skips an optional package built for another platform, as it does esbuild's Linux build on a Mac.
LINUX_ESBUILD = {"version": "0.28.2", "resolved": "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz",
                 "integrity": "sha512-esbuild-0.28.2", "optional": True, "os": ["linux"], "cpu": ["x64"]}
LOCKED = {"node_modules/next": NEXT, "node_modules/react": REACT, "node_modules/@esbuild/linux-x64": LINUX_ESBUILD}
# What npm ci installs from LOCKED on a Mac, recorded in its hidden lockfile.
INSTALLED = {"node_modules/next": NEXT, "node_modules/react": REACT}


class CheckApplicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr application checks ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.repo = base / "checkout"
        (self.repo / "bin").mkdir(parents=True)
        for name in ("bin/check-application", "bin/_ios_check_records.py", "bin/_npm_packages.py"):
            shutil.copy2(SOURCE / name, self.repo / name)
        shutil.copy2(SOURCE / "package.json", self.repo / "package.json")
        (self.repo / "package-lock.json").write_text(json.dumps(self.lockfile(LOCKED, root=True)))
        self.install(INSTALLED)
        (self.repo / "ops").mkdir()
        (self.repo / "ops/deploy.sh").write_text("#!/bin/sh\nexit 0\n")
        (self.repo / "ops/Caddyfile").write_text("example.invalid\n")
        (self.repo / "tests").mkdir()
        self.events = base / "events.jsonl"
        for name in ("first", "second"):
            (self.repo / "tests" / f"test_{name}.py").write_text(
                "import json, os, unittest\n"
                "class Probe(unittest.TestCase):\n"
                "    def test_probe(self):\n"
                "        with open(os.environ['CHECK_EVENTS'], 'a') as stream:\n"
                f"            stream.write(json.dumps(['{name}']) + '\\n')\n"
                "        self.assertNotIn('FAIL_PYTHON', os.environ)\n")
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        self.tool("node", "import os\nprint(os.environ.get('CHECK_NODE_VERSION', 'v24.20.0'))\n")
        self.tool("shellcheck", "import json, os, sys\n"
                                "open(os.environ['CHECK_EVENTS'], 'a').write(json.dumps(['shellcheck', *[os.path.basename(a) for a in sys.argv[1:]]]) + '\\n')\n")
        self.tool("npm", "import json, os, sys\n"
                         "shard = ['SCREENR_TEST_SHARD=' + os.environ['SCREENR_TEST_SHARD']] "
                         "if 'SCREENR_TEST_SHARD' in os.environ else []\n"
                         "open(os.environ['CHECK_EVENTS'], 'a').write(json.dumps(['npm', *sys.argv[1:], *shard]) + '\\n')\n"
                         "if sys.argv[-1] == os.environ.get('FAIL_APPLICATION'):\n"
                         "    print('application check failed: ' + sys.argv[-1], file=sys.stderr)\n"
                         "    sys.exit(17)\n")
        self.env = {key: value for key, value in os.environ.items()
                    if key not in {"FAIL_PYTHON", "FAIL_APPLICATION", "FAIL_IOS"} and not key.startswith("GIT_")}
        self.env.update(PATH=str(self.tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1",
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        (self.tools / "git").symlink_to(shutil.which("git"))
        check_ios = self.repo / "bin/check-ios"
        check_ios.write_text("#!" + sys.executable + "\n"
                             "import json, os, sys\n"
                             "open(os.environ['CHECK_EVENTS'], 'a').write(json.dumps(['check-ios', *sys.argv[1:]]) + '\\n')\n"
                             "sys.exit(19 if 'FAIL_IOS' in os.environ else 0)\n")
        check_ios.chmod(0o755)

    @staticmethod
    def lockfile(packages, root=False):
        """Return an npm lockfile; the hidden one that npm writes in node_modules leaves out the root package."""
        top = {"": {"name": "screenr", "version": "0.1.0"}} if root else {}
        return {"name": "screenr", "version": "0.1.0", "lockfileVersion": 3, "requires": True,
                "packages": top | packages}

    def install(self, packages, root=False):
        (self.repo / "node_modules").mkdir(exist_ok=True)
        (self.repo / "node_modules/.package-lock.json").write_text(json.dumps(self.lockfile(packages, root)))

    def assert_stops_for_packages(self, *details):
        for args in ([], ["--part", "static"], ["--part", "app"], ["--part", "browser", "--shard", "1/2"]):
            with self.subTest(args=args):
                self.events.unlink(missing_ok=True)
                result = self.check(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Run npm ci", result.stderr)
                for detail in details:
                    self.assertIn(detail, result.stderr)
                self.assertEqual(self.recorded(), [])

    def tool(self, name, body):
        path = self.tools / name
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def git(self, *args):
        subprocess.run(["git", "-c", "user.name=Check", "-c", "user.email=check@example.invalid", *args],
                       cwd=self.repo, env=self.env, check=True, capture_output=True)

    def on_mac_with_main(self):
        """Simulate macOS with Xcode, in a checkout whose origin/main includes the iPhone app."""
        self.tool("xcodebuild", "import sys\nsys.exit(1)\n")
        (self.repo / "ios/Screenr").mkdir(parents=True)
        (self.repo / "ios/Screenr/ScreenrApp.swift").write_text("struct ScreenrApp {}\n")
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("add", "--all")
        self.git("commit", "--quiet", "--message", "Main")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")

    def edit_app(self):
        (self.repo / "ios/Screenr/ScreenrApp.swift").write_text("struct ScreenrApp { let edited = true }\n")

    def assert_ios_checks_run_last(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()[-2:], [["npm", "run", SCRIPTS[-1]], IOS_CHECK])
        self.assertIn("Running iOS checks: the iOS files differ from origin/main", result.stdout)

    def check(self, *args, **extra):
        return subprocess.run([str(self.repo / "bin/check-application"), *args], cwd=self.repo,
                              env=self.env | extra, text=True, capture_output=True, timeout=60)

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def test_runs_shell_lint_python_tests_then_npm_scripts_in_order(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [["shellcheck", "--shell=sh", "deploy.sh"], ["first"], ["second"],
                                           *[["npm", "run", script] for script in SCRIPTS]])
        self.assertIn("Application checks passed", result.stdout)

    def test_newer_node_majors_run_the_checks(self):
        for version in ("v25.8.0", "v26.8.1", "v28.0.0"):
            with self.subTest(version=version):
                self.events.unlink(missing_ok=True)
                result = self.check(CHECK_NODE_VERSION=version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.recorded()[-1], ["npm", "run", SCRIPTS[-1]])

    def test_old_or_missing_node_stops_before_any_check(self):
        for version in ("v20.19.5", "v22.18.0", "v23.11.1"):
            with self.subTest(version=version):
                result = self.check(CHECK_NODE_VERSION=version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Node.js >=24 is required", result.stderr)
                self.assertIn("latest Node LTS", result.stderr)
                self.assertIn(version, result.stderr)
                self.assertEqual(self.recorded(), [])
        (self.tools / "node").unlink()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node.js >=24 is required", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_stale_installed_packages_stop_before_any_check(self):
        # A pull moved package-lock.json to Next.js 16.4.2 while node_modules kept 16.4.0 (#334).
        self.install(INSTALLED | {"node_modules/next": NEXT | {
            "version": "16.4.0", "resolved": "https://registry.npmjs.org/next/-/next-16.4.0.tgz",
            "integrity": "sha512-next-16.4.0"}})
        self.assert_stops_for_packages("node_modules/next: 16.4.0 is installed but 16.4.2 is locked")

    def test_any_difference_from_the_lockfile_stops_before_any_check(self):
        for installed, detail in (
                ({"node_modules/next": NEXT}, "node_modules/react: 19.3.1 is locked but not installed"),
                (INSTALLED | {"node_modules/left-pad": {"version": "1.3.0"}},
                 "node_modules/left-pad: 1.3.0 is installed but not in package-lock.json"),
                (INSTALLED | {"node_modules/next": NEXT | {"integrity": "sha512-rebuilt"}},
                 "node_modules/next: 16.4.2 is installed from another source than the locked one"),
                (INSTALLED | {"node_modules/@esbuild/linux-x64": LINUX_ESBUILD | {"version": "0.27.0"}},
                 "node_modules/@esbuild/linux-x64: 0.27.0 is installed but 0.28.2 is locked")):
            with self.subTest(detail=detail):
                self.install(installed)
                self.assert_stops_for_packages(detail)

    def test_missing_or_unreadable_installed_packages_stop_before_any_check(self):
        shutil.rmtree(self.repo / "node_modules")
        self.assert_stops_for_packages("No packages are installed", "node_modules/.package-lock.json")
        self.install(INSTALLED)
        (self.repo / "node_modules/.package-lock.json").write_text("{")
        self.assert_stops_for_packages("node_modules/.package-lock.json cannot be read")

    def test_installed_packages_may_leave_out_optional_ones_npm_skipped(self):
        # Only the packages count, not the project's own entry at the root.
        for installed, root in ((INSTALLED, False), (LOCKED, False), (INSTALLED, True)):
            with self.subTest(optional="node_modules/@esbuild/linux-x64" in installed, root=root):
                self.events.unlink(missing_ok=True)
                self.install(installed, root)
                result = self.check()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.recorded()[-1], ["npm", "run", SCRIPTS[-1]])

    def test_failures_propagate_and_stop_later_commands(self):
        result = self.check(FAIL_PYTHON="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("npm", [event[0] for event in self.recorded()])
        for index, script in enumerate(SCRIPTS):
            with self.subTest(script=script):
                self.events.unlink(missing_ok=True)
                result = self.check(FAIL_APPLICATION=script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("application check failed: " + script, result.stderr)
                self.assertEqual([event for event in self.recorded() if event[0] == "npm"],
                                 [["npm", "run", name] for name in SCRIPTS[:index + 1]])

    def test_a_full_run_ignores_an_inherited_application_test_shard(self):
        result = self.check(SCREENR_TEST_SHARD="1/2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(["npm", "run", "test"], self.recorded())

    def test_ci_parts_split_the_full_run(self):
        static = [["shellcheck", "--shell=sh", "deploy.sh"], ["first"], ["second"],
                  ["npm", "run", "format:check"], ["npm", "run", "typecheck"]]
        for args, events in (
                (["--part", "static"], static),
                (["--part", "app"], [["npm", "run", "test"]]),
                (["--part", "app", "--shard", "2/3"], [["npm", "run", "test", "SCREENR_TEST_SHARD=2/3"]]),
                (["--part", "browser"], [["npm", "run", "test:browser"]]),
                (["--part", "browser", "--shard", "3/3"], [["npm", "run", "test:browser", "--", "--shard=3/3"]])):
            with self.subTest(args=args):
                self.events.unlink(missing_ok=True)
                result = self.check(*args, SCREENR_TEST_SHARD="1/2")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.recorded(), events)
                self.assertIn(f"Application {args[1]} checks passed", result.stdout)

    def test_ci_parts_never_run_ios_checks(self):
        self.on_mac_with_main()
        self.edit_app()
        for part in ("static", "app", "browser"):
            with self.subTest(part=part):
                result = self.check("--part", part)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("check-ios", [event[0] for event in self.recorded()])

    def test_invalid_parts_and_shards_stop_before_any_check(self):
        for args in (["--part", "ios"], ["--shard", "1/2"], ["--part", "static", "--shard", "1/2"],
                     ["--part", "app", "--shard", "0/2"], ["--part", "app", "--shard", "3/2"],
                     ["--part", "browser", "--shard", "1"], ["--part", "browser", "--shard", "a/b"]):
            with self.subTest(args=args):
                result = self.check(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("usage: check-application", result.stderr)
                self.assertEqual(self.recorded(), [])

    def test_failures_in_a_part_propagate(self):
        result = self.check("--part", "static", FAIL_APPLICATION="typecheck")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Application static checks passed", result.stdout)
        result = self.check("--part", "browser", "--shard", "1/2", FAIL_APPLICATION="--shard=1/2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("application check failed: --shard=1/2", result.stderr)

    def test_skips_ios_checks_without_xcode(self):
        (self.repo / "ios").mkdir()
        (self.repo / "ios/Changed.swift").write_text("struct Changed {}\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("check-ios", [event[0] for event in self.recorded()])
        self.assertIn("Skipping iOS checks: they need macOS with Xcode.", result.stdout)

    def test_runs_ios_checks_on_a_mac_for_a_committed_ios_change(self):
        self.on_mac_with_main()
        self.edit_app()
        self.git("commit", "--quiet", "--all", "--message", "Edit the app")
        self.assert_ios_checks_run_last()

    def test_runs_ios_checks_on_a_mac_for_a_staged_or_unstaged_ios_change(self):
        self.on_mac_with_main()
        self.edit_app()
        self.assert_ios_checks_run_last()
        self.events.unlink()
        self.git("add", "--all")
        self.assert_ios_checks_run_last()

    def test_runs_ios_checks_on_a_mac_for_an_untracked_ios_file(self):
        self.on_mac_with_main()
        (self.repo / "ios/Screenr/New.swift").write_text("struct New {}\n")
        self.assert_ios_checks_run_last()

    def test_skips_ios_checks_on_a_mac_when_ios_matches_main(self):
        self.on_mac_with_main()
        (self.repo / "ops/deploy.sh").write_text("#!/bin/sh\nexit 0\n# Edited.\n")
        self.git("commit", "--quiet", "--all", "--message", "Web only")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("check-ios", [event[0] for event in self.recorded()])
        self.assertIn("Skipping iOS checks: the iOS files match origin/main", result.stdout)

    def test_skips_ios_checks_on_a_mac_for_changes_to_markdown_directly_in_ios(self):
        self.on_mac_with_main()
        (self.repo / "ios/README.md").write_text("# The iPhone app\n")
        self.git("add", "--all")
        self.git("commit", "--quiet", "--message", "Document the app")
        (self.repo / "ios/AGENTS.md").write_text("# Rules\n")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("check-ios", [event[0] for event in self.recorded()])
        self.assertIn("Skipping iOS checks: the iOS files match origin/main", result.stdout)

    def test_runs_ios_checks_on_a_mac_for_markdown_in_a_folder_under_ios(self):
        # Xcode builds every file in the app's synchronized folder, Markdown included.
        self.on_mac_with_main()
        (self.repo / "ios/Screenr/Notes.md").write_text("Draft notes.\n")
        self.assert_ios_checks_run_last()

    def test_runs_ios_checks_on_a_mac_for_a_check_script_change(self):
        self.on_mac_with_main()
        (self.repo / "bin/format-swift").write_text("#!/bin/sh\n# Stricter.\n")
        self.assert_ios_checks_run_last()

    def test_runs_ios_checks_on_a_mac_without_origin_main(self):
        self.on_mac_with_main()
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded()[-1], IOS_CHECK)
        self.assertIn("Running iOS checks: there is no origin/main to compare the iOS files with.", result.stdout)

    def test_ios_check_failures_fail_the_application_checks(self):
        self.on_mac_with_main()
        self.edit_app()
        result = self.check(FAIL_IOS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.recorded()[-1], IOS_CHECK)
        self.assertNotIn("Application checks passed", result.stdout)


class WorkflowTests(unittest.TestCase):
    """CI's parallel jobs run every part of the full check, and deployment waits for all of them."""

    def setUp(self):
        jobs = (SOURCE / ".github/workflows/check.yml").read_text().split("\njobs:\n")[1]
        self.jobs = dict(re.findall(r"^  ([a-z]+):\n((?:(?:    .*)?\n)*)", jobs, re.M))

    def test_ci_runs_the_foundation_and_every_part_and_shard(self):
        script = ast.parse((SOURCE / "bin/check-application").read_text())
        parts = next(ast.literal_eval(node.value) for node in script.body
                     if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None) == "PARTS")
        self.assertIn("        run: ./bin/check\n", self.jobs["static"])
        for part in parts:
            with self.subTest(part=part):
                job = self.jobs[part]
                if part == "static":
                    self.assertIn("        run: bin/check-application --part static\n", job)
                    continue
                self.assertIn(f"run: bin/check-application --part {part} "
                              "--shard ${{ matrix.shard }}/${{ strategy.job-total }}\n", job)
                shards = json.loads(re.search(r"^        shard: (\[.*\])$", job, re.M)[1])
                self.assertEqual(shards, list(range(1, len(shards) + 1)))

    def test_check_reports_every_check_job_and_gates_deployment(self):
        checks = [name for name in self.jobs if name not in ("check", "deploy")]
        self.assertEqual(sorted(checks), ["app", "browser", "release", "scope", "static"])
        self.assertIn(f"    needs: [{', '.join(checks)}]\n", self.jobs["check"])
        self.assertIn("    if: ${{ !cancelled() }}\n", self.jobs["check"])
        self.assertIn("    needs: [check, release]\n", self.jobs["deploy"])

    def test_scope_decides_whether_the_check_jobs_run(self):
        # bin/ci-scope compares a pull request's test merge commit with its
        # first parent, so the checkout needs both.
        scope = self.jobs["scope"]
        self.assertIn("          fetch-depth: 2", scope)
        self.assertIn("    outputs:\n      run: ${{ steps.scope.outputs.run }}\n", scope)
        self.assertIn("        id: scope\n", scope)
        self.assertIn("          EVENT_NAME: ${{ github.event_name }}\n", scope)
        self.assertIn('        run: bin/ci-scope "$EVENT_NAME" >> "$GITHUB_OUTPUT"\n', scope)
        for name in ("static", "app", "browser", "release"):
            with self.subTest(job=name):
                self.assertIn("    needs: scope\n    if: needs.scope.outputs.run == 'true'\n", self.jobs[name])

    def test_check_passes_only_when_every_job_passed_or_scope_skipped_them(self):
        script = textwrap.dedent(self.jobs["check"].split("        run: |\n", 1)[1])

        def check(scope, run, **results):
            needs = {"scope": {"result": scope, "outputs": {"run": run} if run else {}}}
            for name in ("static", "app", "browser", "release"):
                needs[name] = {"result": results.get(name, "success"), "outputs": {}}
            # GitHub runs a step's script with these bash options.
            return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                                  env={**os.environ, "NEEDS": json.dumps(needs)},
                                  capture_output=True, text=True).returncode == 0

        skipped = dict.fromkeys(("static", "app", "browser", "release"), "skipped")
        self.assertTrue(check("success", "true"))
        self.assertTrue(check("success", "false", **skipped))
        self.assertFalse(check("success", "true", release="failure"))
        self.assertFalse(check("success", "true", app="cancelled"))
        self.assertFalse(check("success", "true", browser="skipped"))
        self.assertFalse(check("success", "false", **{**skipped, "static": "failure"}))
        self.assertFalse(check("failure", "", **skipped))
        self.assertFalse(check("skipped", "false", **skipped))

    def test_every_run_packages_the_release_and_only_a_deployment_uploads_it(self):
        # A pull request that breaks packaging fails CI instead of blocking the next deployment.
        steps = re.split(r"^      - ", self.jobs["release"], flags=re.M)[1:]
        find = lambda text: next(step for step in steps if text in step)
        package = find("npm run release:package\n")
        for text in ("uses: ./.github/actions/node-lts\n", "npm run release:package\n"):
            with self.subTest(step=text):
                self.assertNotRegex(find(text), r"(?m)^(        )?if:")
        self.assertLess(package.index("npm ci\n"), package.index("npm run build\n"))
        self.assertLess(package.index("npm run build\n"), package.index("npm run release:package\n"))
        deploying = "steps.decision.outputs.deploy == 'true' && github.repository == 'jubishop/screenr'"
        self.assertIn(f"        if: {deploying}\n", find("uses: actions/upload-artifact@"))
        self.assertIn("    if: needs.release.outputs.deploy == 'true' && github.repository == 'jubishop/screenr'\n",
                      self.jobs["deploy"])

    def test_check_jobs_use_the_ubuntu_mirror_only_for_missing_tools(self):
        # A slow mirror held Playwright's --with-deps past a job's timeout (#320).
        # The runner image already has Chromium's libraries and ShellCheck.
        for name in ("app", "browser"):
            with self.subTest(job=name):
                job = re.sub(r"^ *#.*\n", "", self.jobs[name], flags=re.M)
                self.assertIn("      - run: npx playwright install --only-shell chromium\n", job)
                for apt in ("--with-deps", "install-deps", "apt-get", "ci-apt.conf"):
                    self.assertNotIn(apt, job)
        static = self.jobs["static"]
        guard = static.index("if ! command -v shellcheck >/dev/null; then\n")
        end = static.index("fi\n", guard)
        uses = [use.start() for use in re.finditer("apt-get", static)]
        self.assertTrue(uses)
        self.assertTrue(all(guard < use < end for use in uses), static)
        # tests/test_ci_apt.py exercises the policy that the static job installs.
        self.assertIn("sudo install -m 0644 .github/ci-apt.conf /etc/apt/apt.conf.d/99-screenr-ci\n",
                      static[:guard])


if __name__ == "__main__":
    unittest.main()
