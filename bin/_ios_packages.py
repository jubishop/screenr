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
then a later command does.

SwiftPM still extracts its own copy of the frameworks into each scratch path
it builds in, such as swift test's and SourceKit-LSP's index build.
share_artifacts() makes those copies APFS clones of the cache's identical
files. See ios/README.md#package-cache.
"""

import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import sys
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
# The SwiftPM scratch paths in a checkout, each with its own copy of the
# packages' binary artifacts: swift test's in bin/check-ios, SourceKit-LSP's
# index build, and a swift command's default. With Swift Build, SourceKit-LSP
# builds its index under the directory it started in, such as the checkout's
# root.
SCRATCH_PATHS = ("ios/build/ScreenrKit", "ios/ScreenrKit/.build/index-build", ".build/index-build",
                 "ios/ScreenrKit/.build")
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


class _AttributeList(ctypes.Structure):
    _fields_ = [("bitmapcount", ctypes.c_ushort), ("reserved", ctypes.c_uint16), ("commonattr", ctypes.c_uint32),
                ("volattr", ctypes.c_uint32), ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                ("forkattr", ctypes.c_uint32)]


def _checked(status, path):
    if status:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(path))


def _data_id(libc, path):
    """APFS's ID for a file's data, which its clones share until one of them changes."""
    # ATTR_CMNEXT_CLONEID, read with FSOPT_NOFOLLOW and FSOPT_ATTR_CMN_EXTENDED.
    attributes = _AttributeList(5, 0, 0, 0, 0, 0, 0x100)
    buffer = ctypes.create_string_buffer(16)
    _checked(libc.getattrlist(os.fsencode(path), ctypes.byref(attributes), buffer, len(buffer), 0x21), path)
    return struct.unpack_from("=IQ", buffer)[1]


def _remote_artifacts(directory):
    """The download checksum of each remote artifact in SwiftPM's workspace state there, by package and target."""
    try:
        state = json.loads((directory / "workspace-state.json").read_text())
        return {(artifact["packageRef"]["identity"], artifact["targetName"]): artifact["source"]["checksum"]
                for artifact in state["object"]["artifacts"] if artifact["source"]["type"] == "remote"}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def share_artifacts(root):
    """Make the artifacts SwiftPM extracted into the checkout's scratch paths APFS clones of the cache's files.

    Each of SCRATCH_PATHS holds its own copy of sentry-cocoa's frameworks,
    about 3.3 GB, the same files as the cache's. A clone shares its data with
    the cache's file, taking no space until either changes, and stays a file of
    its own: SwiftPM replacing it, or bound() deleting the cache, leaves the
    other intact. It does nothing except on macOS. Call it while this process
    holds the cache in use, so nothing deletes the files it clones.

    SwiftPM replaces an artifact only when the checksum that its workspace state
    records for it changes. So only artifacts recorded with the cache's checksum
    qualify, and in them only files with the cache file's size, mode, and
    modification time that don't already share its data. A clone keeps the
    modification time, so Clang's modules built against the headers stay valid.
    It is made beside the files and renamed over one, so a reader finds the old
    file or the clone, never neither.
    """
    if sys.platform != "darwin":
        return
    libc = ctypes.CDLL(None, use_errno=True)
    cache = sources(root)
    checksums = _remote_artifacts(cache)
    shared = 0
    for name in SCRATCH_PATHS:
        scratch = root / name
        # A clone stays here only if a process stopped between making it and
        # renaming it.
        for leftover in scratch.glob(".screenr-clone-*"):
            leftover.unlink(missing_ok=True)
        staged = scratch / f".screenr-clone-{os.getpid()}"
        for (package, target), checksum in _remote_artifacts(scratch).items():
            if checksums.get((package, target)) != checksum:
                continue
            copies = scratch / "artifacts" / package / target
            for directory, _, files in os.walk(copies):
                for file in files:
                    copy = Path(directory, file)
                    original = cache / "artifacts" / package / target / copy.relative_to(copies)
                    try:
                        mine, theirs = copy.lstat(), original.lstat()
                        if (not stat.S_ISREG(mine.st_mode) or not mine.st_size
                                or (mine.st_mode, mine.st_size, mine.st_mtime_ns)
                                != (theirs.st_mode, theirs.st_size, theirs.st_mtime_ns)
                                or _data_id(libc, copy) == _data_id(libc, original)):
                            continue
                        # CLONE_NOFOLLOW
                        _checked(libc.clonefile(os.fsencode(original), os.fsencode(staged), 1), original)
                        try:
                            os.rename(staged, copy)
                        finally:
                            staged.unlink(missing_ok=True)
                        shared += mine.st_size
                    except OSError:
                        # SwiftPM removed or replaced the file meanwhile, or the
                        # volume can't clone it.
                        continue
    if shared:
        print(f"{shared / GB:.1f} GB of SwiftPM's package artifacts in this checkout now share the identical files "
              f"of the shared iOS package cache in {CACHE}.", flush=True)
