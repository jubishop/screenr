"""Run the release cleanup CLI against real, disposable release directories."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReleaseRetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.releases = self.root / 'releases'
        self.releases.mkdir()

    def release(self, number, *, pending=False, success=False):
        path = self.releases / f'{number:040x}'
        path.mkdir()
        (path / 'REVISION').write_text(path.name + '\n')
        (path / 'server.js').write_text('// app')
        if pending:
            (path / '.deployment-pending').touch()
        if success:
            marker = path / '.deployment-success'
            marker.touch()
            os.utime(marker, (number, number))
        os.utime(path, (number, number))
        return path

    def activate(self, path):
        (self.root / 'current').unlink(missing_ok=True)
        (self.root / 'current').symlink_to(path)

    def execute(self, active):
        return subprocess.run([sys.executable, str(ROOT / 'ops/prune-releases.py'), str(active)],
                              text=True, capture_output=True, timeout=5)

    def test_first_cleanup_keeps_active_and_two_recent_legacy_releases(self):
        copies = [self.release(i) for i in range(1, 7)]
        active = copies[0]  # The active release need not be the newest directory.
        self.activate(active)
        for _ in range(2):
            result = self.execute(active)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(set(self.releases.iterdir()), {active, *copies[-2:]})
            self.assertEqual((self.root / 'current').resolve(), active)

    def test_failed_candidate_cannot_displace_successful_rollback_copies(self):
        older = self.release(1, success=True)
        previous = self.release(2, success=True)
        failed = self.release(3, pending=True)
        active = self.release(4, pending=True)
        self.activate(active)
        result = self.execute(active)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.releases.iterdir()), {older, previous, active})
        self.assertFalse(failed.exists())
        self.assertFalse((active / '.deployment-pending').exists())
        self.assertTrue((active / '.deployment-success').is_file())

    def test_success_time_controls_retention_when_directory_mtime_changes(self):
        copies = [self.release(i, success=True) for i in range(1, 5)]
        os.utime(copies[0], (900, 900))
        active = copies[-1]
        self.activate(active)
        result = self.execute(active)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.releases.iterdir()), set(copies[1:]))

    def test_changed_active_release_or_busy_deployment_preserves_every_copy(self):
        copies = [self.release(i, pending=True) for i in range(1, 5)]
        self.activate(copies[-1])
        result = self.execute(copies[0])
        self.assertNotEqual(result.returncode, 0)
        with (self.root / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.execute(copies[-1])
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(set(self.releases.iterdir()), set(copies))
        self.assertTrue(all((path / '.deployment-pending').exists() for path in copies))

    def test_symlinks_and_unrecognized_directories_are_preserved(self):
        active = self.release(1)
        self.activate(active)
        unrelated = self.releases / 'operator-notes'
        unrelated.mkdir()
        mismatched = self.release(2)
        (mismatched / 'REVISION').write_text('different revision')
        external = self.root / 'other-application'
        external.mkdir()
        sentinel = external / 'keep'
        sentinel.write_text('untouched')
        linked = self.releases / ('f' * 40)
        linked.symlink_to(external)
        result = self.execute(active)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.releases.iterdir()), {active, unrelated, mismatched, linked})
        self.assertEqual(sentinel.read_text(), 'untouched')
