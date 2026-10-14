"""Record passing bin/check-ios runs by the exact iOS files they tested.

bin/check-ios records a pass when the checkout's iOS files match HEAD, and
bin/check-ios --reuse, the pre-push hook, and the TestFlight release skip a
run when the same files already passed with the same Xcode within
LIFETIME. The records live in the clone's Git directory, so every worktree
of the clone shares them; see docs/development-workflow.md#ios-checks-before-a-push.
"""

from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

# The files bin/check-ios tests: the app and the formatter that its build runs.
# Markdown under ios/ documents the app, and no check reads it. The check script
# itself has its own tests in tests/test_check_ios.py.
PATHS = ("ios", "bin/format-swift")
PATHSPEC = (*PATHS, ":(exclude,glob)ios/**/*.md")
LIFETIME = timedelta(days=7)
STORE = "screenr-ios-checks"


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def checked(path):
    return not (path.startswith("ios/") and path.endswith(".md"))


def files_key(root, commit):
    """Identify a commit's iOS files by their modes and object IDs, or return None without any under ios/."""
    try:
        listing = git(root, "ls-tree", "-r", "-z", commit, "--", *PATHS)
    except (OSError, subprocess.CalledProcessError):
        return None
    entries = [entry for entry in listing.split("\0") if entry and checked(entry.split("\t", 1)[1])]
    if not any(entry.split("\t", 1)[1].startswith("ios/") for entry in entries):
        return None
    return hashlib.sha256("\n".join(entries).encode()).hexdigest()


def working_key(root):
    """Return HEAD's key when the checkout's iOS files match HEAD exactly, or None."""
    try:
        if git(root, "status", "--porcelain", "--untracked-files=all", "--", *PATHSPEC):
            return None
    except (OSError, subprocess.CalledProcessError):
        return None
    return files_key(root, "HEAD")


def xcode_version():
    """The selected Xcode, such as "Xcode 27.0 Build version 27A266a", or None without one."""
    try:
        output = subprocess.run(["xcodebuild", "-version"], check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return " ".join(output.split()) or None


def store(root):
    return Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()) / STORE


def passed(root, key, xcode, now=None):
    """Return the recorded pass for these files and this Xcode within LIFETIME, or None."""
    if not key or not xcode:
        return None
    try:
        found = json.loads((store(root) / f"{key}.json").read_text())
        age = (now or datetime.now(timezone.utc)) - datetime.fromisoformat(found["passedAt"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError):
        return None
    if found.get("xcode") != xcode or not timedelta(0) <= age <= LIFETIME:
        return None
    return found


def record(root, key, xcode, now=None):
    """Record a pass for these files, and remove records older than LIFETIME."""
    now = now or datetime.now(timezone.utc)
    directory = store(root)
    directory.mkdir(parents=True, exist_ok=True)
    for old in directory.glob("*.json"):
        try:
            if now - datetime.fromtimestamp(old.stat().st_mtime, timezone.utc) > LIFETIME:
                old.unlink()
        except OSError:
            pass
    entry = {"key": key, "xcode": xcode, "passedAt": now.isoformat(timespec="seconds"),
             "commit": git(root, "rev-parse", "HEAD").strip(), "checkout": str(root)}
    with tempfile.NamedTemporaryFile("w", dir=directory, suffix=".tmp", delete=False) as stream:
        json.dump(entry, stream)
        stream.write("\n")
    os.replace(stream.name, directory / f"{key}.json")
