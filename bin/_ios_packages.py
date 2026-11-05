"""The iPhone app's Swift package cache, which every checkout on the Mac shares.

xcodebuild resolves the app's packages, mostly sentry-cocoa's prebuilt
frameworks, about 3.5 GB for each release, into a directory of the cache named
for ios/ScreenrKit/Package.resolved. Checkouts with the same Package.resolved
share it, and one on another version never changes the sources that another
builds against. xcodebuild and SwiftPM also download into the cache. Each
checkout keeps only its build output. bin/check-ios and bin/ios-packages, which
the TestFlight archive and hand-run commands use, call use() first.

Resolution runs under the cache's exclusive lock, so two commands never write
the same directory at once. Each command then holds the cache in use, under a
shared lock, until it exits. When the cache has grown past LIMIT_GB, the next
command deletes it and resolves again, unless another command holds it in use;
then a later command does. See ios/README.md#package-cache.
"""

import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import time

CACHE = Path(os.environ.get("SCREENR_IOS_PACKAGE_CACHE") or Path.home() / "Library/Caches/screenr-ios-packages")
RESOLVED = "ios/ScreenrKit/Package.resolved"
# Each release of sentry-cocoa takes about 4.5 GB with its downloads, as du
# counts it, so the cache keeps two before a third makes the next command
# delete it.
LIMIT_GB = 12
LOCK = "resolve.lock"
USERS = "users.lock"
POLL_SECONDS = 2
# A first resolution downloaded about 1 GB in under 30 seconds on 2026-11-04.
RESOLVE_TIMEOUT_MINUTES = 15
GB = 1024 ** 3


def pins(root):
    """The hash of the checkout's Package.resolved, which names its packages."""
    try:
        return hashlib.sha256((root / RESOLVED).read_bytes()).hexdigest()
    except FileNotFoundError:
        return "none"


def sources(root):
    """The directory that holds xcodebuild's resolved package sources for this checkout."""
    return CACHE / "sources" / pins(root)[:16]


def downloads():
    """The download cache that xcodebuild and SwiftPM share."""
    return CACHE / "swiftpm"


def xcodebuild_options(root):
    # Only the versions in Package.resolved, so each sources directory holds the
    # packages it is named for.
    return ["-clonedSourcePackagesDirPath", str(sources(root)), "-packageCachePath", str(downloads()),
            "-onlyUsePackageVersionsFromResolvedFile"]


def swift_options():
    # SwiftPM keeps resolved packages in its scratch path, with the build, and
    # can't place them elsewhere, so it shares only the downloads.
    return ["--cache-path", str(downloads())]


def resolve_command(root):
    return ["xcodebuild", "-resolvePackageDependencies", "-project", "ios/Screenr.xcodeproj",
            *xcodebuild_options(root)]


def lock(name, operation):
    """Lock one of the cache's lock files, and return its descriptor, or None if another process holds it.

    The descriptor stays open until it is closed or this process exits, and
    child processes do not inherit it.
    """
    descriptor = os.open(CACHE / name, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        fcntl.flock(descriptor, operation | fcntl.LOCK_NB)
        return descriptor
    except BlockingIOError:
        os.close(descriptor)
        return None


def size():
    """The apparent size of everything in the cache, in bytes."""
    total = 0
    for directory, _, files in os.walk(CACHE):
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except FileNotFoundError:
                pass
    return total


def bound():
    """Delete the cache's contents, keeping its locks, when it has grown past LIMIT_GB and nothing uses it."""
    held = size()
    if held <= LIMIT_GB * GB:
        return
    exclusive = lock(USERS, fcntl.LOCK_EX)
    if exclusive is None:
        print(f"The shared iOS package cache in {CACHE} holds {held / GB:.1f} GB, over its {LIMIT_GB} GB limit, "
              "but another command is using it; a later one will delete it.", flush=True)
        return
    try:
        print(f"Deleting the shared iOS package cache in {CACHE}: it holds {held / GB:.1f} GB, over its "
              f"{LIMIT_GB} GB limit.", flush=True)
        for entry in CACHE.iterdir():
            if entry.name in (LOCK, USERS):
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
    finally:
        os.close(exclusive)


def use(root, resolve=None):
    """Prepare the cache for this checkout, and hold it in use until this process exits.

    Under the cache's lock, this deletes it if bound() calls for that, then
    passes resolve_command(root) to resolve, when given, which must run it and
    raise if it fails. It takes the shared lock before releasing the cache's
    lock, so no deletion can come between resolving and using the packages.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    waiting = False
    while (exclusive := lock(LOCK, fcntl.LOCK_EX)) is None:
        if not waiting:
            print(f"Waiting for the shared iOS package cache in {CACHE}: another command is resolving packages "
                  "into it or deleting it.", flush=True)
            waiting = True
        time.sleep(POLL_SECONDS)
    try:
        bound()
        if resolve:
            resolve(resolve_command(root))
        # Only a holder of the cache's lock, which this process is, takes this
        # one exclusively, so the shared lock is free to take.
        if lock(USERS, fcntl.LOCK_SH) is None:
            raise OSError(f"Could not hold the shared iOS package cache in {CACHE} in use.")
    finally:
        os.close(exclusive)
