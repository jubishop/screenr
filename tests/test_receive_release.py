"""Exercise the deploy key's forced command against disposable host directories.

The receiver is the only command that the production deploy key can run as
root. These tests load it from ops/, point its host paths at a temporary
directory, and replace the installed deploy kit's scripts with recorders.
"""
import contextlib
import fcntl
import hashlib
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from _deploy_kit import kit_digest  # noqa: E402

REVISION = 'a' * 40
OTHER = 'b' * 40


def load_receiver():
    loader = SourceFileLoader('receive_release', str(ROOT / 'ops/receive-release'))
    spec = spec_from_loader('receive_release', loader)
    assert spec
    module = module_from_spec(spec)
    loader.exec_module(module)
    return module


def file_member(name, content=b'', mode=0o644):
    member = tarfile.TarInfo(name)
    member.size = len(content)
    member.mode = mode
    return member, content


def directory_member(name, mode=0o755):
    member = tarfile.TarInfo(name)
    member.type = tarfile.DIRTYPE
    member.mode = mode
    return member, None


def link_member(name, target, kind=tarfile.SYMTYPE):
    member = tarfile.TarInfo(name)
    member.type = kind
    member.linkname = target
    member.mode = 0o777
    return member, None


def release_members(revision=REVISION):
    """The shape of a packaged release, including its relative links."""
    return [directory_member('./'),
            file_member('./REVISION', (revision + '\n').encode()),
            file_member('./server.js', b'// server'),
            directory_member('./node_modules'),
            directory_member('./node_modules/.bin'),
            directory_member('./node_modules/tsx'),
            file_member('./node_modules/tsx/cli.mjs', b'// cli', 0o755),
            link_member('./node_modules/.bin/tsx', '../tsx/cli.mjs'),
            directory_member('./.next'),
            directory_member('./.next/node_modules'),
            link_member('./.next/node_modules/pg-587764f78a6c7a9c', '../../node_modules/pg'),
            directory_member('./node_modules/pg'),
            directory_member('./ops'),
            file_member('./ops/backup.sh', b'#!/bin/sh\n')]


def archive_bytes(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for member, content in members:
            archive.addfile(member, io.BytesIO(content) if content is not None else None)
    return buffer.getvalue()


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.receiver = load_receiver()
        self.screenr = self.base / 'opt/screenr'
        (self.screenr / 'releases' / OTHER).mkdir(parents=True)
        (self.screenr / 'releases' / OTHER / 'REVISION').write_text(OTHER + '\n')
        (self.screenr / 'current').symlink_to(self.screenr / 'releases' / OTHER)
        self.kit = self.base / 'kit'
        self.kit.mkdir()
        self.record = self.base / 'record'
        # Recorders stand in for the installed kit's scripts. They receive
        # only the receiver's fixed environment, so they log to a fixed path.
        (self.kit / 'deploy-release.sh').write_text(
            f'printf "%s\\n" "deploy-release" "$@" "PATH=$PATH" >> {self.record}\n'
            f'[ ! -e {self.base / "deploy-fails"} ] || exit "$(cat {self.base / "deploy-fails"})"\n')
        (self.kit / 'prune-releases.py').write_text(
            'import os, sys\n'
            f'open({str(self.record)!r}, "a").write("\\n".join(["prune-releases", *sys.argv[1:]]) + "\\n")\n'
            f'sys.exit(1 if os.path.exists({str(self.base / "prune-fails")!r}) else 0)\n')
        for name in ('activate.sh', 'host-config.py', 'Caddyfile', 'postgresql.conf', 'screenr-web.service'):
            (self.kit / name).write_text(f'# {name}\n')
        self.upload = self.base / 'var/lib/screenr-deploy/release.tar.gz'
        self.upload.parent.parent.mkdir(parents=True)
        for name, value in (('SCREENR', self.screenr), ('KIT', self.kit), ('UPLOAD', self.upload),
                            ('PYTHON', Path(sys.executable))):
            patcher = mock.patch.object(self.receiver, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(self.receiver.os, 'geteuid', return_value=0)
        self.geteuid = patcher.start()
        self.addCleanup(patcher.stop)

    def kit_files(self):
        files = {path.name: path.read_bytes() for path in self.kit.iterdir()}
        files['receive-release'] = (ROOT / 'ops/receive-release').read_bytes()
        return files

    def receive(self, command, stdin=b''):
        stdout, stderr = io.StringIO(), io.StringIO()
        # The forced command runs the receiver without arguments.
        with (mock.patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}),
              mock.patch.object(sys, 'argv', ['screenr-receive-release']),
              mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(stdin))),
              contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr)):
            status = self.receiver.main()
        return status, stdout.getvalue(), stderr.getvalue()

    def recorded(self):
        return self.record.read_text().splitlines() if self.record.exists() else []

    def upload_archive(self, members=None, revision=REVISION, checksum=None):
        data = archive_bytes(release_members() if members is None else members)
        checksum = checksum or hashlib.sha256(data).hexdigest()
        return (*self.receive(f'upload {revision} {checksum}', data), data, checksum)


class ProtocolTests(ReceiverTests):
    def test_refuses_every_other_command(self):
        checksum = 'c' * 64
        for command in ('', 'id', 'sh -c id', 'status; id', 'status && id', 'status\nid', 'status ',
                        ' status', 'STATUS', 'discard now', 'upload', f'upload {REVISION}',
                        f'upload {REVISION} {checksum} extra', f'deploy {REVISION} {checksum}',
                        f'deploy {REVISION} {checksum} {checksum} extra', f'finalize {REVISION.upper()}',
                        f'finalize {REVISION[:39]}', f'finalize ../../../etc/{REVISION}',
                        f'finalize {REVISION}\n', 'scp -t /tmp', 'rsync --server . /tmp',
                        'cat /opt/screenr/current/REVISION', 'python3 -c "print(1)"',
                        f'deploy $(id) {checksum} {checksum}', 'internal-sftp',
                        f'extract {self.upload} /opt/screenr/releases/{REVISION} {REVISION}'):
            with self.subTest(command=command):
                status, stdout, stderr = self.receive(command, b'payload')
                self.assertEqual(status, 1)
                self.assertIn('Refused', stderr)
                self.assertEqual(stdout, '')
                self.assertEqual(self.recorded(), [])
                self.assertFalse(self.upload.exists())

    def test_runs_only_as_root(self):
        self.geteuid.return_value = 1000
        status, stdout, stderr = self.receive('status')
        self.assertEqual(status, 1)
        self.assertIn('root', stderr)
        self.assertEqual(stdout, '')


class StatusTests(ReceiverTests):
    def status(self):
        status, stdout, stderr = self.receive('status')
        self.assertEqual(status, 0, stderr)
        return json.loads(stdout)

    def test_reports_active_revision_and_installed_kit(self):
        self.assertEqual(self.status(), {'active': OTHER, 'kit': kit_digest(self.kit_files())})

    def test_kit_digest_changes_with_any_kit_file(self):
        before = self.status()['kit']
        (self.kit / 'screenr-web.service').write_text('# changed\n')
        self.assertNotEqual(self.status()['kit'], before)
        (self.kit / 'screenr-new.timer').write_text('# added\n')
        self.assertEqual(self.status()['kit'], kit_digest(self.kit_files()))

    def test_new_host_has_no_active_release(self):
        # A provisioned host that never activated a release.
        (self.screenr / 'current').unlink()
        (self.screenr / 'releases' / OTHER / 'REVISION').unlink()
        (self.screenr / 'releases' / OTHER).rmdir()
        self.assertIsNone(self.status()['active'])

    def test_missing_active_revision_on_used_host_fails_closed(self):
        def remove_release(screenr, rename=None):
            (screenr / 'releases' / OTHER / 'REVISION').unlink()
            if rename:
                (screenr / 'releases' / OTHER).rename(screenr / 'releases' / rename)
            else:
                (screenr / 'releases' / OTHER).rmdir()

        damages = {
            'dangling active link': remove_release,
            'active link removed': lambda screenr: (screenr / 'current').unlink(),
            'active manifest removed': lambda screenr: (screenr / 'releases' / OTHER / 'REVISION').unlink(),
            'unreadable manifest': lambda screenr: (screenr / 'releases' / OTHER / 'REVISION').write_text('x\n'),
            'other release directory': lambda screenr: ((screenr / 'current').unlink(),
                                                        remove_release(screenr, 'bootstrap')),
            'releases directory missing': lambda screenr: ((screenr / 'current').unlink(), remove_release(screenr),
                                                           (screenr / 'releases').rmdir()),
        }
        for name, damage in damages.items():
            with self.subTest(name=name):
                self.setUp()
                damage(self.screenr)
                status, stdout, stderr = self.receive('status')
                self.assertEqual(status, 1)
                self.assertIn('Could not read the active production revision', stderr)
                self.assertEqual(stdout, '')


class UploadTests(ReceiverTests):
    def test_valid_release_is_stored_for_deployment(self):
        status, stdout, stderr, data, checksum = self.upload_archive()
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.upload.read_bytes(), data)
        self.assertEqual(self.upload.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.upload.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(path.name for path in self.upload.parent.iterdir()), ['release.tar.gz'])
        self.assertIn(REVISION, stdout)

    def test_new_upload_replaces_the_previous_one(self):
        self.upload_archive()
        members = release_members() + [file_member('./extra.js', b'// extra')]
        status, stdout, stderr, data, checksum = self.upload_archive(members)
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.upload.read_bytes(), data)

    def assert_rejected(self, result, message):
        status, stdout, stderr = result[:3]
        self.assertEqual(status, 1, stdout)
        self.assertIn(message, stderr)
        self.assertFalse(self.upload.exists())
        self.assertEqual(list(self.upload.parent.iterdir()) if self.upload.parent.exists() else [], [])
        self.assertEqual(self.recorded(), [])

    def test_checksum_mismatch_is_rejected(self):
        self.upload_archive()
        self.assert_rejected(self.upload_archive(checksum='c' * 64), 'checksum')

    def test_oversized_upload_is_rejected(self):
        with mock.patch.object(self.receiver, 'ARCHIVE_LIMIT', 1024):
            members = release_members() + [file_member('./big.bin', os.urandom(4096))]
            self.assert_rejected(self.upload_archive(members), 'exceeds')

    def test_unsafe_or_incomplete_archives_are_rejected(self):
        cases = {
            'absolute path': [file_member('/etc/cron.d/screenr', b'* * * * * root id\n')],
            'parent path': [file_member('./../escape', b'x')],
            'nested parent path': [file_member('./node_modules/../../escape', b'x')],
            'hard link': [link_member('./hard', 'server.js', tarfile.LNKTYPE)],
            'character device': [(tarfile.TarInfo('./device'), None)],
            'fifo': [(tarfile.TarInfo('./fifo'), None)],
            'setuid file': [file_member('./tool', b'x', 0o4755)],
            'setgid directory': [directory_member('./shared', 0o2755)],
            'world-writable file': [file_member('./open.js', b'x', 0o666)],
            'world-writable directory': [directory_member('./open', 0o777)],
            'absolute link': [link_member('./etc', '/etc')],
            'escaping link': [link_member('./up', '../other')],
            'deep escaping link': [link_member('./node_modules/.bin/up', '../../../x')],
            'empty link': [link_member('./empty', '')],
            'link through a link': [link_member('./here', '.'), link_member('./up', 'here/..')],
            'link into a link': [link_member('./modules', 'node_modules'),
                                 link_member('./tool', 'modules/tsx/cli.mjs')],
            'member through a link': [link_member('./modules', 'node_modules'),
                                      file_member('./modules/injected.js', b'x')],
            'duplicate member': [file_member('./server.js', b'// replaced')],
            'release cache link': [link_member('./.next/cache', '../node_modules')],
            'pending marker': [file_member('./.deployment-pending')],
            'success marker': [link_member('./.deployment-success', 'server.js')],
        }
        cases['character device'][0][0].type = tarfile.CHRTYPE
        cases['fifo'][0][0].type = tarfile.FIFOTYPE
        for name, extra in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(self.upload_archive(release_members() + extra), 'Release archive')

    def test_release_build_directory_cannot_be_a_link(self):
        members = [entry for entry in release_members() if not entry[0].name.startswith('./.next')]
        self.assert_rejected(self.upload_archive(members + [link_member('./.next', 'node_modules')]),
                             'Release archive')

    def test_release_identity_files_are_required(self):
        without = lambda name: [entry for entry in release_members() if entry[0].name != name]  # noqa: E731
        cases = {
            'missing revision': without('./REVISION'),
            'missing server': without('./server.js'),
            'revision link': without('./REVISION') + [link_member('./REVISION', 'server.js')],
            'server directory': without('./server.js') + [directory_member('./server.js')],
            'other revision': release_members(OTHER),
        }
        for name, members in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(self.upload_archive(members), 'Release archive')

    def test_unreadable_upload_is_rejected(self):
        data = b'not a gzip archive'
        checksum = hashlib.sha256(data).hexdigest()
        self.assert_rejected(self.receive(f'upload {REVISION} {checksum}', data), 'Release archive')

    def test_archive_size_limits(self):
        with mock.patch.object(self.receiver, 'MEMBER_LIMIT', 5):
            self.assert_rejected(self.upload_archive(), 'entries')
        with mock.patch.object(self.receiver, 'CONTENT_LIMIT', 8):
            self.assert_rejected(self.upload_archive(), 'unpacks')

    def test_upload_waits_for_no_one_holding_the_deploy_lock(self):
        with (self.screenr / 'deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assert_rejected(self.upload_archive(), 'holds /opt/screenr/deploy.lock')


class DeployTests(ReceiverTests):
    def deploy(self, kit=None):
        status, stdout, stderr, data, checksum = self.upload_archive()
        self.assertEqual(status, 0, stderr)
        kit = kit or kit_digest(self.kit_files())
        return (*self.receive(f'deploy {REVISION} {checksum} {kit}'), checksum)

    def test_runs_the_installed_deploy_script_with_a_fixed_environment(self):
        status, stdout, stderr, checksum = self.deploy()
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.recorded(), ['deploy-release', REVISION, checksum, str(self.upload),
                                           'PATH=' + self.receiver.ENVIRONMENT['PATH']])

    def test_deploy_status_is_returned(self):
        # Status 69 tells the CI helper that production is down.
        for code in (1, 69):
            with self.subTest(code=code):
                (self.base / 'deploy-fails').write_text(str(code))
                self.assertEqual(self.deploy()[0], code)

    def test_kit_mismatch_refuses_before_deploying(self):
        status, stdout, stderr, checksum = self.deploy(kit='c' * 64)
        self.assertEqual(status, 1)
        self.assertIn('bin/install-deploy-kit', stderr)
        self.assertEqual(self.recorded(), [])

    def test_missing_upload_refuses_before_deploying(self):
        kit = kit_digest(self.kit_files())
        status, stdout, stderr = self.receive(f'deploy {REVISION} {"c" * 64} {kit}')
        self.assertEqual(status, 1)
        self.assertIn('No uploaded release', stderr)
        self.assertEqual(self.recorded(), [])

    def test_unexpected_kit_entry_fails_closed(self):
        (self.kit / 'nested').mkdir()
        status, stdout, stderr = self.receive('status')
        self.assertEqual(status, 1)
        self.assertIn('deploy kit', stderr)


class ExtractTests(ReceiverTests):
    """ops/deploy-release.sh extracts with the receiver, so one parser checks and extracts."""

    def setUp(self):
        super().setUp()
        self.release = self.screenr / 'releases' / REVISION
        self.release.mkdir()

    def extract(self, data, revision=REVISION, destination=None):
        archive = self.base / 'release.tar.gz'
        archive.write_bytes(data)
        stderr = io.StringIO()
        argv = ['screenr-receive-release', 'extract', str(archive), str(destination or self.release), revision]
        with (mock.patch.object(sys, 'argv', argv), mock.patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': 'status'}),
              contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr)):
            return self.receiver.main(), stderr.getvalue()

    def test_extracts_a_checked_release(self):
        status, stderr = self.extract(archive_bytes(release_members()))
        self.assertEqual(status, 0, stderr)
        self.assertEqual((self.release / 'REVISION').read_text(), REVISION + '\n')
        self.assertEqual(os.readlink(self.release / 'node_modules/.bin/tsx'), '../tsx/cli.mjs')
        self.assertEqual((self.release / 'node_modules/tsx/cli.mjs').stat().st_mode & 0o7777, 0o755)
        self.assertEqual((self.release / 'server.js').stat().st_mode & 0o7777, 0o644)

    def test_unsafe_archive_extracts_nothing(self):
        for extra in ([link_member('./up', '../other')], [file_member('./tool', b'x', 0o4755)],
                      [link_member('./modules', 'node_modules'), file_member('./modules/injected.js', b'x')]):
            with self.subTest(extra=extra[0][0].name):
                status, stderr = self.extract(archive_bytes(release_members() + extra))
                self.assertEqual(status, 1)
                self.assertIn('Release archive', stderr)
                self.assertEqual(list(self.release.iterdir()), [])

    def test_only_an_empty_directory_for_the_revision_is_a_destination(self):
        data = archive_bytes(release_members())
        (self.screenr / 'releases' / 'other').mkdir()
        for destination in (self.screenr / 'releases' / 'other', self.screenr / 'releases' / OTHER,
                            self.base / REVISION):
            with self.subTest(destination=destination):
                status, stderr = self.extract(data, destination=destination)
                self.assertEqual(status, 1)
                self.assertIn('destination', stderr)
        self.assertEqual(self.extract(data, revision=OTHER, destination=self.release)[0], 1)
        self.assertEqual(list(self.release.iterdir()), [])

    def test_other_arguments_are_refused(self):
        for argv in (['screenr-receive-release', 'status'],
                     ['screenr-receive-release', 'extract', str(self.upload), str(self.release)],
                     ['screenr-receive-release', 'unpack', str(self.upload), str(self.release), REVISION]):
            with self.subTest(argv=argv), mock.patch.object(sys, 'argv', argv):
                stderr = io.StringIO()
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
                    self.assertEqual(self.receiver.main(), 1)
                self.assertIn('Usage', stderr.getvalue())


class CleanupTests(ReceiverTests):
    def test_discard_removes_the_upload(self):
        self.upload_archive()
        status, stdout, stderr = self.receive('discard')
        self.assertEqual(status, 0, stderr)
        self.assertFalse(self.upload.exists())
        # Discarding again, or with nothing uploaded, also succeeds.
        self.assertEqual(self.receive('discard')[0], 0)

    def test_finalize_runs_the_installed_cleanup_for_the_release(self):
        status, stdout, stderr = self.receive(f'finalize {REVISION}')
        self.assertEqual(status, 0, stderr)
        self.assertEqual(self.recorded(), ['prune-releases', str(self.screenr / 'releases' / REVISION)])
        (self.base / 'prune-fails').touch()
        self.assertEqual(self.receive(f'finalize {REVISION}')[0], 1)


if __name__ == '__main__':
    unittest.main()
