"""Check the Node.js runtime and the installed npm packages, for bin/check-application and bin/setup-application.

npm records what it installed in node_modules/.package-lock.json after each
install, so comparing that record with package-lock.json shows whether
node_modules holds what npm ci installs, as in CI and production.
"""

import json
import shutil
import subprocess

# The lockfile fields that name what npm installs at each path.
PACKAGE_IDENTITY = ("version", "resolved", "integrity", "link")
RECORD = "node_modules/.package-lock.json"
UNREADABLE = (OSError, ValueError, LookupError, TypeError, AttributeError)


class StalePackages(RuntimeError):
    """node_modules doesn't hold what npm ci installs from package-lock.json, so npm ci would fix it."""


def require_node(root, purpose, rerun):
    """Stop unless the node on PATH meets the engines minimum in package.json."""
    required = json.loads((root / "package.json").read_text())["engines"]["node"]
    minimum = int(required.removeprefix(">="))
    runtime_help = (f"Node.js {required} is required for {purpose}. "
                    f"Select the latest Node LTS release and rerun {rerun}.")
    if not shutil.which("node"):
        raise RuntimeError(runtime_help)
    found = subprocess.check_output(["node", "--version"], cwd=root, text=True).strip()
    major = found.removeprefix("v").split(".")[0]
    if not major.isdigit() or int(major) < minimum:
        raise RuntimeError(f"{runtime_help} Found {found}.")


def lockfile_packages(path):
    """Read an npm lockfile's packages by node_modules path, leaving out the project itself at the empty path."""
    return {name: entry for name, entry in json.loads(path.read_text())["packages"].items() if name}


def package_differences(locked, installed):
    """List how the installed packages differ from the locked ones, by their node_modules paths."""
    for path, entry in sorted(locked.items()):
        found = installed.get(path)
        if found is None:
            # npm skips optional packages that don't fit this machine, such as another platform's build.
            if not entry.get("optional"):
                yield f"{path}: {entry.get('version')} is locked but not installed"
        elif found.get("version") != entry.get("version"):
            yield f"{path}: {found.get('version')} is installed but {entry.get('version')} is locked"
        elif any(found.get(field) != entry.get(field) for field in PACKAGE_IDENTITY):
            yield f"{path}: {found.get('version')} is installed from another source than the locked one"
    for path in sorted(installed.keys() - locked.keys()):
        yield f"{path}: {installed[path].get('version')} is installed but not in package-lock.json"


def require_locked_packages(root):
    """Stop unless node_modules holds what npm ci installs from package-lock.json.

    Raise StalePackages when installing would fix node_modules, and RuntimeError
    when package-lock.json itself cannot be read.
    """
    try:
        locked = lockfile_packages(root / "package-lock.json")
    except UNREADABLE as error:
        raise RuntimeError(f"package-lock.json cannot be read ({type(error).__name__}: {error}).") from None
    if not (root / RECORD).exists():
        raise StalePackages(f"No packages are installed: {RECORD} is missing.")
    try:
        differences = list(package_differences(locked, lockfile_packages(root / RECORD)))
    except UNREADABLE as error:
        raise StalePackages(f"{RECORD} cannot be read ({type(error).__name__}: {error}).") from None
    if differences:
        shown = differences[:10] + ([f"and {len(differences) - 10} more"] if len(differences) > 10 else [])
        raise StalePackages("The installed packages differ from package-lock.json:\n  " + "\n  ".join(shown))
