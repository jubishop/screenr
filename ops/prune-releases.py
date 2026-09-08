#!/usr/bin/env python3
"""Finalize a publicly verified release and retain two rollback releases."""
import fcntl
from pathlib import Path
import re
import shutil
import sys


def recognized_release(path):
    if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'[0-9a-f]{40}', path.name):
        return False
    manifest = path / 'REVISION'
    return (not manifest.is_symlink() and manifest.is_file()
            and manifest.read_text().strip() == path.name
            and (path / 'server.js').is_file())


def main():
    if len(sys.argv) != 2:
        raise ValueError('Usage: prune-releases.py /path/to/screenr/releases/REVISION')
    release = Path(sys.argv[1]).absolute()
    releases = release.parent
    root = releases.parent
    if releases.name != 'releases' or releases.is_symlink() or not recognized_release(release):
        raise ValueError('Expected a real release directory with a matching REVISION.')
    # Reacquire the activation lock after the CI runner's public health checks.
    # A newer deployment must never be pruned by an older runner.
    with (root / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (root / 'current').resolve(strict=True) != release.resolve(strict=True):
            raise ValueError('Active release changed; refusing cleanup.')
        candidates = [path for path in releases.iterdir() if recognized_release(path)]
        for path in candidates:
            for name in ('.deployment-success', '.deployment-pending'):
                marker = path / name
                if marker.is_symlink() or (marker.exists() and not marker.is_file()):
                    raise ValueError(f'Unexpected deployment marker in {path.name}.')
        retired = root / 'retired-releases'
        if retired.is_symlink():
            raise ValueError('Expected a real retired-releases directory.')
        retired.mkdir(mode=0o700, exist_ok=True)
        (release / '.deployment-success').touch()
        (release / '.deployment-pending').unlink(missing_ok=True)

        def success_time(path):
            marker = path / '.deployment-success'
            if marker.exists():
                return marker.stat().st_mtime_ns
            # Upgrade compatibility: old deployments retained complete release
            # directories but had no success marker. Preserve their newest two.
            return path.stat().st_mtime_ns

        verified = [path for path in candidates if path != release
                    and not (path / '.deployment-pending').exists()]
        keep = {release, *sorted(verified, key=lambda path: (success_time(path), path.name), reverse=True)[:2]}
        # A deletion can fail after removing REVISION or server.js. Resume from
        # this dedicated namespace without relying on those deleted files.
        for path in sorted(retired.iterdir()):
            if not path.is_symlink() and path.is_dir() and re.fullmatch(r'[0-9a-f]{40}', path.name):
                shutil.rmtree(path)
                print(f'Removed retired release {path.name}', flush=True)
        for path in sorted(candidates):
            if path not in keep:
                destination = retired / path.name
                path.rename(destination)
                shutil.rmtree(destination)
                print(f'Removed inactive release {path.name}', flush=True)
        print('Retained releases: ' + ', '.join(sorted(path.name for path in keep)))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(f'Release cleanup failed: {error}', file=sys.stderr)
        sys.exit(1)
