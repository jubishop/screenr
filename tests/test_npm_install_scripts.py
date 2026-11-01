"""Check that every locked package with an install script has an allowScripts decision in package.json.

.npmrc sets strict-allow-scripts, so npm ci fails on an install script that
allowScripts doesn't cover, but only for packages it installs on the current
platform. This check reads the lockfile, so CI on Linux also catches a new
macOS-only script that would stop npm ci on a Mac. See
docs/development-workflow.md#dependency-install-scripts.
"""

import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def package_name(entry):
    """The package name of an allowScripts entry such as esbuild, @scope/pkg, or esbuild@0.28.2."""
    version_at = entry.find("@", 1)
    return entry if version_at == -1 else entry[:version_at]


class NpmInstallScriptTests(unittest.TestCase):
    def test_every_locked_install_script_has_a_decision(self):
        lockfile = json.loads((ROOT / "package-lock.json").read_text())
        decided = {package_name(entry) for entry in json.loads((ROOT / "package.json").read_text()).get("allowScripts", {})}
        scripted = {details.get("name", path.rpartition("node_modules/")[2])
                    for path, details in lockfile["packages"].items() if path and details.get("hasInstallScript")}
        self.assertEqual(set(), scripted - decided,
                         "Approve or deny each listed package's install script with npm install-scripts, "
                         "and record why in docs/development-workflow.md#dependency-install-scripts.")


if __name__ == "__main__":
    unittest.main()
