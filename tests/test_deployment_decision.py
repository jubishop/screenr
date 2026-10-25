"""Exercise the CI deployment decision through its command and real commits."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
# Git exports GIT_DIR and its other repository variables to commands such as
# git rebase --exec. The fixture repository's commands must not follow them
# and commit to the checkout that runs these tests.
REPOSITORY_VARIABLES = set(subprocess.run(["git", "rev-parse", "--local-env-vars"], check=True,
                                          capture_output=True, text=True).stdout.split())
SKIP = "\n\nScreenr-Deploy: skip\nScreenr-Deploy-Reason: Documentation only."

# Stands in for the GitHub CLI: logs each call and replies with the fixture's
# production deployments, or fails when the fixture has none.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
base = Path(os.environ["FIXTURE"])
with (base / "gh-calls").open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
response = base / "deployments.json"
if not response.exists():
    sys.exit(1)
print(response.read_text())
'''


class DeploymentDecisionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.fixture = Path(temporary.name)
        commands = self.fixture / "commands"
        commands.mkdir()
        (commands / "gh").write_text(FAKE_GH)
        (commands / "gh").chmod(0o755)
        self.environment = {key: value for key, value in os.environ.items()
                            if key not in REPOSITORY_VARIABLES}
        self.environment.update(FIXTURE=str(self.fixture),
                                PATH=str(commands) + os.pathsep + os.environ["PATH"])
        self.directory = self.fixture / "repository"
        self.directory.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.com")

    def git(self, *args, cwd=None):
        return subprocess.run(
            ["git", *args], cwd=cwd or self.directory, env=self.environment, check=True,
            capture_output=True, text=True
        ).stdout.strip()

    def commit(self, message):
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def deployments(self, *deployments):
        """Record production deployments, newest first, as (revision, state) pairs."""
        nodes = [{"commitOid": revision, "latestStatus": {"state": state}}
                 for revision, state in deployments]
        (self.fixture / "deployments.json").write_text(
            json.dumps({"data": {"repository": {"deployments": {"nodes": nodes}}}}))

    def gh_calls(self):
        path = self.fixture / "gh-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_decision(self, revision, event="push", ref="refs/heads/main", cwd=None):
        result = subprocess.run(
            [sys.executable, str(ROOT / "bin/deployment-decision"), event, ref, revision],
            cwd=cwd or self.directory, env=self.environment, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def decide(self, message, event="push", ref="refs/heads/main"):
        return self.run_decision(self.commit(message), event, ref)

    def test_push_deploys_by_default_without_reading_deployments(self):
        self.assertEqual(self.decide("Change server behavior").stdout, "deploy=true\n")
        self.assertEqual(self.gh_calls(), [])

    def test_reviewed_immaterial_change_skips_only_deployment(self):
        self.deployments((self.commit("Deployed release"), "SUCCESS"))
        result = self.decide(
            "Clarify project instructions\n\n"
            "Screenr-Deploy: skip\n"
            "Screenr-Deploy-Reason: Instructions only; production already contains all material changes."
        )
        self.assertEqual(result.stdout, "deploy=false\n")
        self.assertIn("Instructions only", result.stderr)
        [call] = self.gh_calls()
        self.assertEqual(call[:2], ["api", "graphql"])
        self.assertIn('environments: ["production"]', " ".join(call))

    def test_skip_applies_when_every_commit_since_the_last_deployment_skips(self):
        self.deployments((self.commit("Deployed release"), "SUCCESS"))
        self.commit("Clarify a guide" + SKIP)
        self.assertEqual(self.decide("Clarify another guide" + SKIP).stdout, "deploy=false\n")

    def test_skip_stacked_on_an_undeployed_functional_commit_deploys(self):
        for undeployed in ("Change server behavior",
                           "Change server behavior\n\nScreenr-Deploy: skip"):
            with self.subTest(undeployed=undeployed):
                base = self.commit("Deployed release")
                functional = self.commit(undeployed)
                # The functional push's deploy job refused because main moved on.
                self.deployments((functional, "FAILURE"), (base, "SUCCESS"))
                result = self.decide("Clarify a guide" + SKIP)
                self.assertEqual(result.stdout, "deploy=true\n")
                self.assertIn(functional, result.stderr)

    def test_newest_successful_deployment_is_the_baseline(self):
        base = self.commit("Deployed release")
        functional = self.commit("Change server behavior")
        self.deployments((functional, "SUCCESS"), (base, "SUCCESS"))
        self.assertEqual(self.decide("Clarify a guide" + SKIP).stdout, "deploy=false\n")

    def test_unknown_deployment_history_deploys(self):
        diverged = self.commit("Deployed release on rewritten history")
        self.git("checkout", "-q", "--orphan", "rewritten")
        self.commit("Rewritten root")
        for name, setup in (
            ("no deployment", lambda: self.deployments()),
            ("only failed deployments", lambda: self.deployments((diverged, "FAILURE"))),
            ("API failure", lambda: (self.fixture / "deployments.json").unlink(missing_ok=True)),
            ("malformed response", lambda: (self.fixture / "deployments.json").write_text("{}")),
            ("unknown revision", lambda: self.deployments(("c" * 40, "SUCCESS"))),
            ("invalid revision", lambda: self.deployments(("main", "SUCCESS"))),
            ("diverged revision", lambda: self.deployments((diverged, "SUCCESS"))),
        ):
            with self.subTest(name):
                setup()
                result = self.decide("Clarify a guide" + SKIP)
                self.assertEqual(result.stdout, "deploy=true\n")
                self.assertIn("Deploying despite", result.stderr)

    def test_shallow_checkout_deploys(self):
        base = self.commit("Deployed release")
        revision = self.commit("Clarify a guide" + SKIP)
        self.deployments((base, "SUCCESS"))
        for depth in ("1", "2"):
            with self.subTest(depth=depth):
                clone = self.fixture / ("clone-" + depth)
                self.git("clone", "-q", "--depth", depth, self.directory.as_uri(), str(clone))
                result = self.run_decision(revision, cwd=clone)
                self.assertEqual(result.stdout, "deploy=true\n")
                self.assertIn("Deploying despite", result.stderr)

    def test_incomplete_or_conflicting_decisions_keep_deployment(self):
        self.deployments((self.commit("Deployed release"), "SUCCESS"))
        for trailers in (
            "Screenr-Deploy: skip",
            "Screenr-Deploy: skip\nScreenr-Deploy-Reason:",
            "Screenr-Deploy: skip\nScreenr-Deploy: deploy\nScreenr-Deploy-Reason: Documentation.",
            "Screenr-Deploy: maybe\nScreenr-Deploy-Reason: Documentation.",
        ):
            with self.subTest(trailers=trailers):
                self.assertEqual(self.decide("Change\n\n" + trailers).stdout, "deploy=true\n")

    def test_mentioning_the_trailer_in_prose_is_not_a_decision(self):
        result = self.decide(
            "Document the Screenr-Deploy: skip convention\n\n"
            "Use Screenr-Deploy-Reason: to explain an immaterial change."
        )
        self.assertEqual(result.stdout, "deploy=true\n")

    def test_manual_main_run_deploys_even_when_the_commit_skips(self):
        self.deployments((self.commit("Deployed release"), "SUCCESS"))
        result = self.decide("Documentation" + SKIP, event="workflow_dispatch")
        self.assertEqual(result.stdout, "deploy=true\n")

    def test_pull_requests_and_other_branches_never_deploy(self):
        for event, ref in (
            ("pull_request", "refs/heads/main"),
            ("push", "refs/heads/feature"),
            ("workflow_dispatch", "refs/heads/feature"),
        ):
            with self.subTest(event=event, ref=ref):
                self.assertEqual(self.decide("Change", event, ref).stdout, "deploy=false\n")
        self.assertEqual(self.gh_calls(), [])

    def test_unreadable_revision_fails_without_a_deployment_decision(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "bin/deployment-decision"),
             "push", "refs/heads/main", "a" * 40],
            cwd=self.directory, env=self.environment, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
