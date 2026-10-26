"""Exercise the weekly memory audit with real disposable Git checkouts and fake services."""

import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE / "bin"))
import _memory_audit as audit  # noqa: E402

README = ("# Memory\n\nPreserve this policy.\n\n## Active memory index\n\n"
          "- [Incident](incident.md): an incident whose entry\n  spans two lines.\n")


class MemoryAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memory audit ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo = self.base / "repo"
        for name in ("bin", "memory", "docs/foundation", ".config"):
            (self.repo / name).mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / "bin/_knowledge.py", self.repo / "bin/_knowledge.py")
        shutil.copy2(SOURCE / ".config/knowledge.json", self.repo / ".config/knowledge.json")
        # Like Screenr's, this ignores .cache/ but not the runner's artifacts/ folder.
        (self.repo / ".gitignore").write_text(".cache/\n")
        (self.repo / "docs/README.md").write_text("# Docs\n")
        (self.repo / "docs/foundation/README.md").write_text("# Foundation\n")
        self.note = self.repo / "memory/incident.md"
        self.content = ("---\nname: incident\ndescription: An incident.\ntype: project\nstatus: active\n---\n\n"
                        "# Incident\n\nA durable rule.\n")
        self.note.write_text(self.content)
        self.readme = self.repo / "memory/README.md"
        self.readme.write_text(README)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Audit test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("add", ".")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "✅ test: Add memory audit fixture")
        self.origin = self.base / "origin.git"
        subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", str(self.origin)], check=True)
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "--quiet", "origin", "main")
        self.head = self.git("rev-parse", "HEAD")
        self.fake = self.base / "tools"
        self.fake.mkdir()
        self.result = {
            "report": "# Memory audit report\n\n- Active notes reviewed: 1\n\n## Per-note findings\n\nIncident checked.\n",
            "findings": [{"path": "memory/incident.md", "verdict": "keep", "evidence": "Current source keeps the rule."}],
            "changes": [],
        }
        self.response = self.base / "response.json"
        self.calls = self.base / "calls.jsonl"
        # What the model looks at: notes it reads, and other reads and searches.
        self.session = {"reads": ["memory/incident.md"], "lookups": 1}
        self.session_file = self.base / "session.json"
        self.gh_calls = self.base / "gh-calls.jsonl"
        self.open_issues = self.base / "open-issues.json"
        self.notifications = self.base / "notifications.jsonl"
        self.qmd_config = self.base / "qmd-index.yml"
        # The GitHub CLI keeps the open failure issues in a file, so a create is seen by later lists.
        self.executable("gh", (
            "import json,pathlib,sys\n"
            "args = sys.argv[1:]\n"
            "body = sys.stdin.read() if '--body-file' in args else None\n"
            f"with open({str(self.gh_calls)!r}, 'a') as f: f.write(json.dumps({{'args': args, 'body': body}})+'\\n')\n"
            f"issues = pathlib.Path({str(self.open_issues)!r})\n"
            "if args[:2] == ['issue', 'list'] and '--search' in args:\n"
            " print(issues.read_text() if issues.exists() else '[]')\n"
            "elif args[:2] == ['issue', 'create']:\n"
            " issues.write_text(json.dumps([{'number': 999, 'title': args[args.index('--title') + 1]}]))\n"
            " print('https://github.com/jubishop/screenr/issues/999')\n"
            "elif args[:2] == ['issue', 'close']:\n"
            " issues.write_text(json.dumps([i for i in json.loads(issues.read_text()) if str(i['number']) != args[2]]))\n"
            "elif args[1:2] == ['list']:\n"
            " print('[]')\n"
        ))
        self.executable("osascript", (
            "import json,sys\n"
            f"with open({str(self.notifications)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
        ))
        self.executable("qmd", (
            "import os,pathlib,sys\n"
            "if sys.argv[1:] == ['update']:\n"
            f" pathlib.Path({str(self.qmd_config)!r}).write_text("
            "(pathlib.Path(os.environ['QMD_CONFIG_DIR']) / 'index.yml').read_text())\n"
            "print('Index ready')\n"
        ))
        self.executable("claude", (
            "import json,os,pathlib,sys\n"
            "status = sys.argv[1:3] == ['auth','status']\n"
            "prompt = '' if status else sys.stdin.read()\n"
            f"with open({str(self.calls)!r}, 'a') as f: f.write(json.dumps({{'args':sys.argv[1:], 'env':dict(os.environ), 'prompt':prompt}})+'\\n')\n"
            "if status:\n print(json.dumps({'loggedIn':True,'authMethod':'claude.ai','apiProvider':'firstParty'}))\n"
            "else:\n"
            f" response=json.loads(pathlib.Path({str(self.response)!r}).read_text())\n"
            f" calls=[json.loads(x) for x in pathlib.Path({str(self.calls)!r}).read_text().splitlines()]\n"
            " attempt=sum('-p' in c['args'] for c in calls)-1\n"
            " if isinstance(response,list): response=response[attempt]\n"
            f" session=json.loads(pathlib.Path({str(self.session_file)!r}).read_text())\n"
            " if isinstance(session,list): session=session[attempt]\n"
            " uses=[('Read',{'file_path':os.path.join(os.getcwd(),path)}) for path in session['reads']]\n"
            " uses+=[('Grep',{'pattern':'rule','path':os.getcwd()})]*session['lookups']\n"
            " for n,(name,args) in enumerate(uses):\n"
            "  print(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','id':str(n),'name':name,'input':args}]}}))\n"
            " print(json.dumps({'type':'result','subtype':'success','structured_output':response}))\n"
        ))
        self.env = patch.dict(os.environ, {"PATH": str(self.fake) + os.pathsep + os.environ["PATH"]})
        self.env.start()
        self.addCleanup(self.env.stop)

    def executable(self, name, body):
        path = self.fake / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o755)

    def git(self, *args, root=None):
        result = subprocess.run(["git", *args], cwd=root or self.repo, text=True,
                                capture_output=True, check=True)
        return result.stdout.strip()

    def run_audit(self, force=False):
        self.response.write_text(json.dumps(self.result))
        self.session_file.write_text(json.dumps(self.session))
        return audit.run(self.repo, force=force)

    def commit_fixture(self, path, message):
        """Commit and push a fixture change, since each audit starts from origin's main."""
        self.git("add", path)
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-m", message)
        self.git("push", "--quiet", "origin", "main")

    def remote_head(self, remote):
        return self.git("rev-parse", "main", root=remote)

    def gh(self, *prefix):
        if not self.gh_calls.exists():
            return []
        calls = [json.loads(line) for line in self.gh_calls.read_text().splitlines()]
        return [call for call in calls if call["args"][:len(prefix)] == list(prefix)]

    def advance_origin(self, path, text):
        """Push a commit to origin, as another session would while the audit runs."""
        other = self.base / "other"
        if not other.exists():
            self.git("clone", "--quiet", str(self.origin), str(other), root=self.base)
        self.git("pull", "--quiet", "origin", "main", root=other)
        (other / path).write_text(text)
        self.git("add", path, root=other)
        self.git("-c", "user.name=Other", "-c", "user.email=other@example.invalid",
                 "commit", "--quiet", "-m", "Other work", root=other)
        self.git("push", "--quiet", "origin", "HEAD:main", root=other)

    def fail_model(self):
        self.executable("claude", "import json,sys\n"
                        "print(json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty'}))\n"
                        "sys.exit(0 if sys.argv[1:3] == ['auth','status'] else 1)\n")

    def archive(self):
        self.result["findings"][0]["verdict"] = "archive"
        self.result["changes"] = [{"path": "memory/incident.md", "archive": True,
                                   "content": self.content.replace("status: active", "status: resolved")}]

    def add_notes(self, readme, *names):
        """Commit more reference notes and a new README, and expect the model to review them too."""
        for name in names:
            (self.repo / "memory" / (name + ".md")).write_text(
                f"---\nname: {name}\ndescription: A {name} lesson.\ntype: reference\n---\n\n# {name.title()}\n\n"
                "A lasting lesson.\n")
        self.readme.write_text(readme)
        self.commit_fixture("memory", "✅ test: Add more memory notes")
        notes = sorted(["incident", *names])
        self.result["report"] = self.result["report"].replace("reviewed: 1", f"reviewed: {len(notes)}")
        self.result["findings"] = [{"path": f"memory/{name}.md", "verdict": "keep", "evidence": "Checked."}
                                   for name in notes]
        self.session = {"reads": [f"memory/{name}.md" for name in notes], "lookups": len(notes)}

    def published_files(self, commit):
        return sorted(self.git("show", "--no-renames", "--name-only", "--format=", commit,
                               root=self.origin).splitlines())

    def test_archive_is_committed_to_main_without_touching_user_checkout(self):
        self.archive()
        self.note.write_text(self.content + "\nUncommitted user edit.\n")
        before = self.note.read_bytes()
        output = self.run_audit()
        self.assertEqual(output["status"], "success")
        self.assertEqual(self.note.read_bytes(), before)
        self.assertEqual(self.readme.read_text(), README)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.head)
        published = output["publishedCommit"]
        self.assertEqual(self.remote_head(self.origin), published)
        self.assertEqual(self.git("rev-parse", published + "^", root=self.origin), self.head)
        self.assertEqual(self.published_files(published),
                         ["memory/README.md", "memory/archive/incident.md", "memory/incident.md"])
        self.assertIn("memory audit", self.git("log", "-1", "--format=%s", published, root=self.origin))
        self.assertEqual(self.git("log", "-1", "--format=%an", published, root=self.origin), "Audit test")
        tree = self.git("ls-tree", "-r", "--name-only", published, "memory", root=self.origin).splitlines()
        self.assertNotIn("memory/incident.md", tree)
        archived = self.git("show", published + ":memory/archive/incident.md", root=self.origin)
        self.assertIn("status: resolved", archived)
        index = self.git("show", published + ":memory/README.md", root=self.origin)
        self.assertIn("Preserve this policy.", index)
        self.assertIn("## Active memory index", index)
        self.assertNotIn("incident", index)
        run_dir = Path(output["directory"])
        self.assertFalse((run_dir / "repository").exists())
        self.assertIn("memory/archive/incident.md", (run_dir / "memory-audit.patch").read_text())
        # The user's edit is unstaged, so the index still matches the audited revision.
        self.git("apply", "--cached", "--check", str(run_dir / "memory-audit.patch"))

    def test_a_memory_only_commit_skips_deployment(self):
        self.archive()
        published = self.run_audit()["publishedCommit"]
        trailers = self.git("log", "-1", "--format=%(trailers:only,unfold)", published, root=self.origin)
        self.assertIn("Screenr-Deploy: skip", trailers.splitlines())
        self.assertRegex(trailers, r"(?m)^Screenr-Deploy-Reason: \S")

    def test_archive_removes_only_that_notes_index_entry(self):
        self.add_notes(
            "# Memory\n\nPreserve this policy.\n\n## Active memory index\n\n"
            "- [Alpha](alpha.md): the first lesson.\n"
            "- [Incident](incident.md): an incident whose entry\n  spans two lines.\n"
            "- [Omega](omega.md): the last lesson,\n  also on two lines.\n",
            "alpha", "omega")
        self.result["findings"][1]["verdict"] = "archive"
        self.result["changes"] = [{"path": "memory/incident.md", "archive": True,
                                   "content": self.content.replace("status: active", "status: resolved")}]
        published = self.run_audit()["publishedCommit"]
        self.assertEqual(self.git("show", published + ":memory/README.md", root=self.origin) + "\n",
                         "# Memory\n\nPreserve this policy.\n\n## Active memory index\n\n"
                         "- [Alpha](alpha.md): the first lesson.\n"
                         "- [Omega](omega.md): the last lesson,\n  also on two lines.\n")

    def test_an_update_leaves_the_readme_untouched(self):
        self.result["changes"] = [{"path": "memory/incident.md", "archive": False,
                                   "content": self.content + "\nVerified against current source.\n"}]
        published = self.run_audit()["publishedCommit"]
        self.assertEqual(self.published_files(published), ["memory/incident.md"])

    def test_an_archive_linked_from_readme_policy_is_rejected(self):
        self.readme.write_text(README.replace("this policy.", "this policy and [the incident](incident.md)."))
        self.commit_fixture("memory/README.md", "✅ test: Link a note from README policy")
        self.archive()
        self.result = [self.result, self.result]
        with self.assertRaisesRegex(ValueError, "memory/README.md: missing link destination incident.md"):
            self.run_audit()
        self.assertEqual(self.remote_head(self.origin), self.git("rev-parse", "HEAD"))

    def test_unchanged_inputs_skip_model_and_force_runs_again(self):
        self.run_audit()
        count = len(self.calls.read_text().splitlines())
        self.assertEqual(self.run_audit()["status"], "skipped")
        self.assertEqual(len(self.calls.read_text().splitlines()), count)
        self.assertEqual(self.run_audit(force=True)["status"], "success")
        self.assertGreater(len(self.calls.read_text().splitlines()), count)

    def test_subscription_only_read_only_claude_invocation(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "fixture-key", "OPENROUTER_API_KEY": "fixture-router"}):
            self.run_audit()
        call = json.loads(self.calls.read_text().splitlines()[-1])
        args = call["args"]
        self.assertEqual(args[args.index("--model") + 1], "claude-haiku-5-5")
        for flag in ("--restricted", "--no-session-persistence", "--strict-mcp-config"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--tools") + 1], "Bash,Read,Glob,Grep")
        self.assertEqual(args[args.index("--permission-mode") + 1], "manual")
        self.assertEqual(args[args.index("--permission-prompts") + 1], "none")
        rules = json.loads(args[args.index("--settings") + 1])["permissions"]
        self.assertFalse([rule for rule in rules["allow"] if not rule.startswith(("Bash(jq ", "Bash(qmd search "))])
        self.assertNotIn("ANTHROPIC_API_KEY", call["env"])
        self.assertNotIn("OPENROUTER_API_KEY", call["env"])

    def test_search_index_holds_only_the_clones_collections(self):
        personal = self.base / "home-memory"
        personal.mkdir()
        self.git("config", "knowledge.homeMemoryPath", str(personal))
        output = self.run_audit()
        clone = Path(output["directory"]) / "repository"
        collections = json.loads(self.qmd_config.read_text())["collections"]
        shared = json.loads((SOURCE / ".config/knowledge.json").read_text())["collections"]
        self.assertEqual(set(collections), set(shared))
        for collection in collections.values():
            self.assertTrue(Path(collection["path"]).is_relative_to(clone), collection["path"])

    def test_api_key_login_stops_before_model_request(self):
        self.executable("claude", "import json\nprint(json.dumps({'loggedIn': True, 'authMethod': 'api_key', "
                        "'apiProvider': 'firstParty'}))\n")
        with self.assertRaisesRegex(RuntimeError, "Claude subscription"):
            self.run_audit()
        self.assertFalse((self.repo / ".cache/memory-audit/last-success.json").exists())

    def test_missing_note_coverage_rejects_result_and_keeps_failure_evidence(self):
        self.result["findings"] = []
        with self.assertRaisesRegex(ValueError, "every active note"):
            self.run_audit()
        state = self.repo / ".cache/memory-audit"
        self.assertEqual(json.loads((state / "latest.json").read_text())["status"], "failed")
        self.assertFalse((state / "last-success.json").exists())

    def test_disallowed_writes_and_archive_overwrites_are_rejected(self):
        for target in ("memory/README.md", "memory/new.md", "memory/../AGENTS.md", "docs/README.md"):
            with self.subTest(target=target):
                self.result["changes"] = [{"path": target, "archive": False, "content": self.content}]
                with self.assertRaisesRegex(ValueError, "existing active note"):
                    self.run_audit()
        self.archive()
        (self.repo / "memory/archive").mkdir()
        (self.repo / "memory/archive/incident.md").write_text("Existing archive\n")
        self.commit_fixture("memory/archive", "✅ test: Add existing archive fixture")
        with self.assertRaisesRegex(ValueError, "existing archive"):
            self.run_audit()

    def test_invalid_metadata_or_links_block_success(self):
        for content in (self.content.replace("status: active", "status: resolved"),
                        self.content + "\n[Missing](missing.md)\n"):
            with self.subTest(content=content):
                self.result["changes"] = [{"path": "memory/incident.md", "archive": False, "content": content}]
                with self.assertRaisesRegex(ValueError, "status must be active|missing link"):
                    self.run_audit()

    def test_failed_model_does_not_export_patch_or_advance_success(self):
        self.fail_model()
        with self.assertRaises(RuntimeError):
            self.run_audit()
        state = self.repo / ".cache/memory-audit"
        meta = json.loads((state / "latest.json").read_text())
        self.assertFalse((Path(meta["directory"]) / "memory-audit.patch").exists())
        self.assertFalse((Path(meta["directory"]) / "repository").exists())
        self.assertTrue((Path(meta["directory"]) / "claude.log").exists())
        self.assertFalse((state / "last-success.json").exists())

    def test_lock_prevents_overlapping_audits(self):
        state = self.repo / ".cache/memory-audit"
        state.mkdir(parents=True)
        with (state / "lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_audit()["status"], "skipped")
        self.assertFalse(self.calls.exists())

    def test_github_activity_invalidates_change_gate(self):
        self.run_audit()
        self.executable("gh", "print('[{\"number\":1,\"state\":\"OPEN\",\"updatedAt\":\"2026-10-02T00:00:00Z\"}]')\n")
        self.assertEqual(self.run_audit()["status"], "success")

    def default_python(self):
        python = self.base / ".local/bin/python3"
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)
        return python

    def test_installer_registers_weekly_job_with_default_python_without_running_it(self):
        self.executable("launchctl", (
            "import json,sys\n"
            f"with open({str(self.calls)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
            "sys.exit(1 if sys.argv[1] == 'print' else 0)\n"
        ))
        for name in ("plutil", "rg", "jq", "node"):
            self.executable(name, "pass\n")
        with patch.object(audit.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.base):
            with self.assertRaisesRegex(RuntimeError, "uv python install --default"):
                audit.install(self.repo)
            self.assertFalse(self.calls.exists())
            python = self.default_python()
            result = audit.install(self.repo)
        self.assertEqual(Path(result["plist"]).name, "com.jubishop.screenr.memory-audit.plist")
        settings = plistlib.loads(Path(result["plist"]).read_bytes())
        self.assertEqual(settings["Label"], "com.jubishop.screenr.memory-audit")
        self.assertEqual(settings["StartCalendarInterval"], {"Weekday": 6, "Hour": 8, "Minute": 0})
        self.assertEqual(settings["ProgramArguments"],
                         ["/bin/sh", "-c", 'exec "$0" "$@"', str(python), "-B", str(self.repo / "bin/memory-audit"), "run"])
        self.assertEqual(settings["EnvironmentVariables"]["PATH"].split(os.pathsep)[0], str(python.parent))
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual([call[0] for call in calls], ["print", "bootstrap", "enable"])

    def test_installer_requires_the_tools_the_audit_uses(self):
        self.executable("launchctl", "import sys\nsys.exit(1 if sys.argv[1] == 'print' else 0)\n")
        for name in ("plutil", "rg", "git"):
            self.executable(name, "pass\n")
        self.default_python()
        # Only the fake tools are on PATH, and jq is not among them.
        with patch.dict(os.environ, {"PATH": str(self.fake)}), \
                patch.object(audit.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.base):
            with self.assertRaisesRegex(RuntimeError, "Missing required command: jq"):
                audit.install(self.repo)

    def test_installer_uses_fnm_default_alias_instead_of_a_node_version(self):
        fnm = self.base / ".local/share/fnm"
        version_bin = fnm / "node-versions/v24.21.0/installation/bin"
        version_bin.mkdir(parents=True)
        (version_bin / "node").write_text(f"#!{sys.executable}\n")
        (version_bin / "node").chmod(0o755)
        (fnm / "aliases").mkdir(parents=True)
        (fnm / "aliases/default").symlink_to(fnm / "node-versions/v24.21.0/installation")
        shell = self.base / "fnm_multishells/123/bin"
        shell.parent.mkdir(parents=True)
        shell.symlink_to(version_bin)
        self.executable("launchctl", "import sys\nsys.exit(1 if sys.argv[1] == 'print' else 0)\n")
        for name in ("plutil", "rg", "jq"):
            self.executable(name, "pass\n")
        self.default_python()
        with patch.dict(os.environ, {"PATH": str(shell) + os.pathsep + os.environ["PATH"]}), \
                patch.object(audit.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.base):
            result = audit.install(self.repo)
        entries = plistlib.loads(Path(result["plist"]).read_bytes())["EnvironmentVariables"]["PATH"].split(os.pathsep)
        self.assertIn(str(fnm / "aliases/default/bin"), entries)
        self.assertFalse([entry for entry in entries if "node-versions" in entry or "fnm_multishells" in entry], entries)

    def test_installed_path_can_run_qmd_with_its_separate_runtime(self):
        runtime = self.base / "runtime"
        runtime.mkdir()
        bun = runtime / "bun"
        bun.write_text(f"#!{sys.executable}\nprint('Runtime ready')\n")
        bun.chmod(0o755)
        self.executable("qmd", "import subprocess\nsubprocess.run(['bun'], check=True)\n")
        self.executable("launchctl", "import sys\nsys.exit(1 if sys.argv[1] == 'print' else 0)\n")
        for name in ("plutil", "rg", "jq"):
            self.executable(name, "pass\n")
        self.default_python()
        with patch.dict(os.environ, {"PATH": str(runtime) + os.pathsep + os.environ["PATH"]}), \
                patch.object(audit.sys, "platform", "darwin"), patch.object(Path, "home", return_value=self.base):
            result = audit.install(self.repo)
        settings = plistlib.loads(Path(result["plist"]).read_bytes())
        result = subprocess.run([str(self.fake / "qmd"), "--version"],
                                env=settings["EnvironmentVariables"], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejected_archive_is_restored_before_one_repair_attempt(self):
        (self.repo / "memory/archive").mkdir()
        (self.repo / "memory/archive/older.md").write_text(
            "---\nname: older\ndescription: Older evidence.\ntype: reference\n---\n\n# Older\n\n[Incident](../incident.md)\n")
        self.commit_fixture("memory/archive", "✅ test: Add an archived backlink fixture")
        self.archive()
        corrected = json.loads(json.dumps(self.result))
        corrected["findings"][0]["verdict"] = "keep"
        corrected["changes"] = []
        self.result = [self.result, corrected]
        output = self.run_audit()
        run_dir = Path(output["directory"])
        self.assertEqual(output["status"], "success")
        # An empty patch shows the repair started from the restored notes and README.
        self.assertEqual((run_dir / "memory-audit.patch").read_text(), "")
        self.assertTrue((run_dir / "rejected-result.json").exists())
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(sum("-p" in call["args"] for call in calls), 2)
        self.assertIn("missing link destination ../incident.md", calls[-1]["prompt"])

    def test_a_run_without_changes_publishes_nothing(self):
        output = self.run_audit()
        self.assertEqual(output["status"], "success")
        self.assertNotIn("publishedCommit", output)
        self.assertEqual(self.remote_head(self.origin), self.head)

    def test_changes_land_on_a_main_that_moved_elsewhere_during_the_audit(self):
        self.archive()
        original = audit.run_model

        def model_then_other_work(*args, **kwargs):
            original(*args, **kwargs)
            self.advance_origin("docs/README.md", "# Docs\n\nNewer.\n")

        with patch.object(audit, "run_model", side_effect=model_then_other_work):
            output = self.run_audit()
        published = output["publishedCommit"]
        self.assertEqual(self.remote_head(self.origin), published)
        self.assertEqual(self.git("log", "-1", "--format=%s", published + "^", root=self.origin), "Other work")

    def test_memory_changed_on_main_during_the_audit_fails_without_pushing(self):
        self.archive()
        original = audit.run_model

        def model_then_memory_edit(*args, **kwargs):
            original(*args, **kwargs)
            self.advance_origin("memory/incident.md", self.content + "\nNewer fact.\n")

        with patch.object(audit, "run_model", side_effect=model_then_memory_edit):
            with self.assertRaisesRegex(RuntimeError, "main changed memory/"):
                self.run_audit()
        self.assertEqual(self.git("log", "-1", "--format=%s", "main", root=self.origin), "Other work")
        self.assertEqual(len(self.gh("issue", "create")), 1)

    def test_a_forced_failure_notifies_and_opens_the_issue_and_the_next_success_closes_it(self):
        working = self.fake / "claude-working"
        shutil.copy2(self.fake / "claude", working)
        self.fail_model()
        with self.assertRaises(RuntimeError):
            self.run_audit(force=True)
        [notification] = [json.loads(line) for line in self.notifications.read_text().splitlines()]
        self.assertIn("Screenr memory audit failed", notification)
        self.assertIn("Claude exited 1", " ".join(notification))
        [created] = self.gh("issue", "create")
        args = created["args"]
        self.assertEqual(args[args.index("--repo") + 1], "jubishop/screenr")
        self.assertEqual(args[args.index("--title") + 1], "Memory audit failing")
        self.assertIn("Claude exited 1", created["body"])
        self.assertIn("next successful run closes this issue", created["body"])
        shutil.copy2(working, self.fake / "claude")
        self.assertEqual(self.run_audit()["status"], "success")
        [closed] = self.gh("issue", "close")
        self.assertEqual(closed["args"][2:5], ["999", "--repo", "jubishop/screenr"])
        self.assertEqual(json.loads(self.open_issues.read_text()), [])
        self.assertEqual(len(self.notifications.read_text().splitlines()), 1)

    def test_a_repeated_failure_comments_on_the_open_issue(self):
        self.open_issues.write_text(json.dumps([{"number": 41, "title": "Memory audit failing"}]))
        self.fail_model()
        with self.assertRaises(RuntimeError):
            self.run_audit()
        self.assertEqual(self.gh("issue", "create"), [])
        [comment] = self.gh("issue", "comment", "41")
        self.assertIn("Claude exited 1", comment["body"])

    def test_a_success_closes_only_the_exact_failure_issue(self):
        self.open_issues.write_text(json.dumps([{"number": 7, "title": "Memory audit failing later"},
                                                {"number": 41, "title": "Memory audit failing"}]))
        self.assertEqual(self.run_audit()["status"], "success")
        [closed] = self.gh("issue", "close")
        self.assertEqual(closed["args"][2], "41")
        self.assertFalse(self.notifications.exists())

    def test_a_failed_run_is_never_skipped_next_time(self):
        self.run_audit()
        working = self.fake / "claude-working"
        shutil.copy2(self.fake / "claude", working)
        self.fail_model()
        with self.assertRaises(RuntimeError):
            self.run_audit(force=True)
        shutil.copy2(working, self.fake / "claude")
        self.assertEqual(self.run_audit()["status"], "success")

    def test_an_unread_note_gets_one_repair_attempt_then_fails(self):
        self.session = [{"reads": [], "lookups": 1}, {"reads": [], "lookups": 0}]
        with self.assertRaisesRegex(ValueError, "not read: memory/incident.md"):
            self.run_audit()
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertIn("not read: memory/incident.md", calls[-1]["prompt"])
        self.assertEqual(self.remote_head(self.origin), self.head)

    def test_reading_the_notes_on_repair_is_accepted(self):
        self.session = [{"reads": [], "lookups": 1}, {"reads": ["memory/incident.md"], "lookups": 0}]
        self.assertEqual(self.run_audit()["status"], "success")

    def test_too_few_source_checks_are_rejected(self):
        self.session = {"reads": ["memory/incident.md"], "lookups": 0}
        with self.assertRaisesRegex(ValueError, "0 source or evidence lookups for 1 note"):
            self.run_audit()

    def test_the_context_lists_commits_since_the_last_audit(self):
        output = self.run_audit()
        context = json.loads((Path(output["directory"]) / "memory-audit-context.json").read_text())
        self.assertTrue(any(line.endswith("✅ test: Add memory audit fixture")
                            for line in context["commitsSinceLastAudit"]))
        self.assertEqual(context["activeNotes"], ["memory/incident.md"])

    def test_runs_older_than_the_retention_window_are_pruned(self):
        runs = self.repo / ".cache/memory-audit/runs"
        old, recent = runs / "20260101T000000Z-old", runs / "20261001T000000Z-recent"
        for directory in (old, recent):
            directory.mkdir(parents=True)
        stale = time.time() - (audit.RETENTION_DAYS + 1) * 86400
        os.utime(old, (stale, stale))
        self.run_audit()
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())


if __name__ == "__main__":
    unittest.main()
