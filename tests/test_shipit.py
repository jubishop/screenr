"""Exercise deployment commands with fake OS, GitHub, and SSH boundaries."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'a' * 40

FAKE_COMMAND = r'''#!/usr/bin/env python3
import json, os, sys, shutil
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
base = Path(os.environ['FIXTURE'])
with (base / 'calls').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'git':
    if args[0] == 'status': print(os.environ.get('DIRTY', ''))
    elif args[0] == 'branch': print(os.environ.get('BRANCH', 'main'))
    elif args[0] == 'rev-parse': print('a'*40)
    elif args[0] == 'config': print('root@example.test')
elif name == 'gh':
    if args[:2] == ['run', 'list']:
        print(json.dumps([dict(databaseId=123, headSha='a'*40)] if (base / 'dispatched').exists() else []))
    elif args[:2] == ['workflow', 'run']:
        (base / 'dispatched').touch()
    elif args[:2] == ['run', 'watch']:
        sys.exit(int(os.environ.get('BUILD_EXIT', '0')))
    elif args[:2] == ['run', 'download']:
        shutil.copyfile(base / 'release.tar.gz', Path(args[-1]) / ('screenr-' + 'a'*40 + '.tar.gz'))
    elif args[-1].endswith('/artifacts'):
        print(json.dumps(dict(artifacts=[dict(name='screenr-linux-x64-'+'a'*40, id=456)])))
    elif args[:3] == ['api', '--method', 'DELETE']:
        pass
    elif 'actions/runs/123' in args[-1]:
        print(json.dumps(dict(conclusion='success', head_branch='main', event='workflow_dispatch', path='.github/workflows/check.yml', head_sha='a'*40)))
    elif 'commits/main' in args[-1]:
        print(json.dumps(dict(sha=os.environ.get('REMOTE_SHA', 'a'*40))))
    else: sys.exit(99)
elif name == 'ssh':
    if args[-1].startswith('mktemp'): print('/tmp/screenr-release.ABC123')
    elif args[-1].startswith('sh -c'):
        sys.exit(int(os.environ.get('SSH_EXIT', '0')))
elif name == 'curl':
    print(os.environ.get('HEALTH', '{"ok":true}') if args[-1].endswith('health') else 'Send sign-in code')
'''


class ShipitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        (self.base / 'bin').mkdir()
        (self.base / 'ops').mkdir()
        shutil.copy2(ROOT / 'bin/shipit', self.base / 'bin/shipit')
        shutil.copy2(ROOT / 'ops/deploy-release.sh', self.base / 'ops/deploy-release.sh')
        self.commands = self.base / 'commands'
        self.commands.mkdir()
        fake = self.commands / 'command'
        fake.write_text(FAKE_COMMAND)
        fake.chmod(0o755)
        for name in ('git', 'gh', 'ssh', 'scp', 'curl'):
            (self.commands / name).symlink_to(fake)
        self.environment = {**os.environ, 'FIXTURE': str(self.base),
                            'PATH': str(self.commands) + os.pathsep + os.environ['PATH']}
        self.make_archive()

    def make_archive(self, revision=REVISION, extra=None):
        with tarfile.open(self.base / 'release.tar.gz', 'w:gz') as archive:
            for name, content in [('REVISION', revision), ('server.js', '// server'),
                                  ('ops/activate.sh', '#!/bin/sh\n')]:
                data = content.encode()
                member = tarfile.TarInfo('./' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)

    def execute(self, *args, **environment):
        return subprocess.run([str(self.base / 'bin/shipit'), *args], cwd=self.base,
                              env={**self.environment, **environment}, text=True,
                              capture_output=True, timeout=15)

    def calls(self):
        path = self.base / 'calls'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_help_requires_no_network(self):
        result = self.execute('--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_build_download_activate_and_check_public_health(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)
        calls = self.calls()
        for command in (['gh', 'workflow', 'run'], ['gh', 'run', 'watch'],
                        ['gh', 'run', 'download'], ['gh', 'api', '--method', 'DELETE']):
            self.assertTrue(any(call[:len(command)] == command for call in calls), command)
        self.assertTrue(any(call[0] == 'scp' for call in calls))
        self.assertTrue(any(call[0] == 'ssh' and call[-1].startswith('sh -c') for call in calls))
        self.assertEqual(len([call for call in calls if call[0] == 'curl']), 2)

    def test_uncommitted_changes_stop_before_build(self):
        result = self.execute(DIRTY=' M src/app.ts')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Commit, review, and merge', result.stderr)
        self.assertFalse(any(call[0] in ('gh', 'ssh') for call in self.calls()))

    def test_feature_branch_stops_before_build(self):
        result = self.execute(BRANCH='feature')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Switch to main', result.stderr)
        self.assertFalse(any(call[0] in ('gh', 'ssh') for call in self.calls()))

    def test_failed_build_never_contacts_host(self):
        result = self.execute(BUILD_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[0] == 'scp' or (call[0] == 'ssh' and call[-1].startswith(('mktemp', 'sh -c'))) for call in self.calls()))

    def test_changed_main_never_contacts_host(self):
        result = self.execute(REMOTE_SHA='b' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('current main', result.stderr)
        self.assertFalse(any(call[0] == 'scp' or (call[0] == 'ssh' and call[-1].startswith(('mktemp', 'sh -c'))) for call in self.calls()))

    def test_mismatched_archive_never_contacts_host(self):
        self.make_archive(revision='b' * 40)
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Archive revision', result.stderr)
        self.assertFalse(any(call[0] == 'scp' or (call[0] == 'ssh' and call[-1].startswith(('mktemp', 'sh -c'))) for call in self.calls()))

    def test_escaping_archive_never_contacts_host(self):
        extra = tarfile.TarInfo('../escape')
        self.make_archive(extra=extra)
        result = self.execute()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unsafe archive', result.stderr)
        self.assertFalse(any(call[0] == 'scp' or (call[0] == 'ssh' and call[-1].startswith(('mktemp', 'sh -c'))) for call in self.calls()))

    def test_failed_activation_cleans_upload_without_success(self):
        result = self.execute(SSH_EXIT='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('DEPLOY SUCCEEDED', result.stdout)
        self.assertTrue(any(call[0] == 'ssh' and call[-1].startswith('rm -f') for call in self.calls()))

    def test_failed_public_health_is_not_success(self):
        result = self.execute(HEALTH='{"ok":false}')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('DEPLOY SUCCEEDED', result.stdout)


class RemoteDeploymentTests(unittest.TestCase):
    def execute_remote(self, **environment):
        # Shell functions fake OS boundaries. Both deployment and activation
        # scripts run unchanged, including their failure and rollback paths.
        harness = r'''
        cd() { :; }
        flock() { [ "${FAIL_LOCK:-}" != yes ]; }
        sha256sum() { command cat >/dev/null; [ "${FAIL_CHECKSUM:-}" != yes ]; }
        systemctl() {
            # systemctl is-active with multiple units succeeds if ANY is active.
            if [ "$1" = is-active ] && [ "$#" -eq 3 ] && [ "$3" = "${FAILED_UNIT:-}" ]; then return 1; fi
            if [ "$1" = start ] && [ "${FAIL_BACKUP:-}" = yes ]; then return 1; fi
            if [ "$1" = show ]; then printf 'Id=fixture\nActiveState=active\n'; fi
        }
        readlink() { command cat "$FIXTURE/current"; }
        mkdir() { printf 'created\n' >> "$FIXTURE/events"; }
        tar() { [ "${FAIL_EXTRACT:-}" != yes ]; }
        rm() { printf 'removed\n' >> "$FIXTURE/events"; }
        cat() { printf '%s\n' "$REVISION"; }
        test() { if [ "$1" = -f ]; then return 0; fi; command test "$@"; }
        alias systemd-run=':'
        chown() { :; }
        ln() { printf '%s\n' "$2" > "$FIXTURE/pending"; }
        mv() { command cp "$FIXTURE/pending" "$FIXTURE/current"; }
        sleep() { :; }
        curl() { [ "${FAIL_HEALTH:-}" != yes ]; }
        sh() (
            script=$1
            shift
            . "$ACTIVATE"
        )
        set -- "$REVISION" "$CHECKSUM" /tmp/screenr-release.fixture
        . "$DEPLOY"
        '''
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = '/opt/screenr/releases/' + REVISION
            (base / 'current').write_text(target if environment.get('ALREADY_ACTIVE') else '/opt/screenr/releases/previous')
            result = subprocess.run(['sh', '-c', harness], cwd=base, capture_output=True, text=True,
                                    env={**os.environ, 'FIXTURE': directory, 'REVISION': REVISION,
                                         'CHECKSUM': 'b' * 64, 'ACTIVATE': str(ROOT / 'ops/activate.sh'),
                                         'DEPLOY': str(ROOT / 'ops/deploy-release.sh'), **environment}, timeout=5)
            events = (base / 'events').read_text() if (base / 'events').exists() else ''
            current = (base / 'current').read_text().strip()
            return result, events, current

    def test_remote_activation_runs_and_preserves_active_release(self):
        result, events, current = self.execute_remote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)
        self.assertNotIn('removed', events)

    def test_backup_failure_does_not_extract_or_activate(self):
        result, events, current = self.execute_remote(FAIL_BACKUP='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')
        self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_extraction_failure_removes_only_new_release(self):
        result, events, current = self.execute_remote(FAIL_EXTRACT='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, 'created\nremoved\n')
        self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_activation_failure_rolls_back_and_cleans_candidate(self):
        result, events, current = self.execute_remote(FAIL_HEALTH='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Activation failed', result.stderr)
        self.assertIn('removed', events)
        self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_repeated_deploy_verifies_without_extracting(self):
        result, events, current = self.execute_remote(ALREADY_ACTIVE='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(events, '')
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)

    def test_lock_failure_does_not_extract_or_activate(self):
        result, events, current = self.execute_remote(FAIL_LOCK='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')
        self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_checksum_failure_does_not_extract_or_activate(self):
        result, events, current = self.execute_remote(FAIL_CHECKSUM='yes')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')
        self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_repeat_deploy_rejects_stopped_worker(self):
        result, events, current = self.execute_remote(ALREADY_ACTIVE='yes', FAILED_UNIT='screenr-worker')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')

    def test_deploy_rejects_stopped_shared_application(self):
        result, events, current = self.execute_remote(FAILED_UNIT='trading')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')
