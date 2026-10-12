"""Exercise deployment commands with fake OS, GitHub, and SSH boundaries."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'a' * 40
# Scripts that run as root on the host. Only their checked Git copies may run.
ROOT_SCRIPTS = ('ops/deploy-release.sh', 'ops/activate.sh', 'ops/prune-releases.py')

FAKE_COMMAND = r'''#!/usr/bin/env python3
import json, os, sys, shutil
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
base = Path(os.environ['FIXTURE'])
with (base / 'calls').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'git':
    if args[0] == 'rev-parse': print(os.environ.get('CHECKOUT_SHA', 'a'*40))
    elif args[0] == 'show':
        revision, _, path = args[1].partition(':')
        if revision != 'a'*40 or path not in ('ops/deploy-release.sh', 'ops/activate.sh', 'ops/prune-releases.py'):
            sys.exit(99)
        if path == os.environ.get('MISSING_CHECKED'): sys.exit(128)
        print((base / 'checked' / path).read_text(), end='')
elif name == 'gh':
    if args[:2] == ['run', 'download']:
        if os.environ.get('WORKTREE_DRIFT'):
            for path in ('ops/deploy-release.sh', 'ops/activate.sh', 'ops/prune-releases.py'):
                (base / path).write_text('echo unchecked-deployment\n')
        shutil.copyfile(base / 'release.tar.gz', Path(args[-1]) / ('screenr-' + 'a'*40 + '.tar.gz'))
    elif args[-1].endswith('/artifacts'):
        print(json.dumps(dict(artifacts=[dict(name='screenr-linux-x64-'+'a'*40, id=456)])))
    elif args[:3] == ['api', '--method', 'DELETE']:
        pass
    elif args[-1].endswith('/jobs'):
        print(json.dumps(dict(jobs=[dict(name='check', conclusion=os.environ.get('CHECK_RESULT', 'success'))])))
    elif 'actions/runs/123' in args[-1]:
        print(json.dumps(dict(conclusion='success', head_branch=os.environ.get('RUN_BRANCH', 'main'),
                             event=os.environ.get('RUN_EVENT', 'push'), path='.github/workflows/check.yml',
                             head_sha=os.environ.get('RUN_SHA', 'a'*40))))
    elif '/compare/' in args[-1]:
        # Linear history 0 -> a -> b; any other revision is on another line.
        if os.environ.get('COMPARE_FAIL'): sys.exit(1)
        count = sum('...main' in line for line in (base / 'calls').read_text().splitlines())
        main = os.environ['LATE_MAIN'] if os.environ.get('LATE_MAIN') and count > 1 else os.environ.get('MAIN_SHA', 'a'*40)
        older, newer = (main if ref == 'main' else ref for ref in args[-1].split('/compare/')[1].split('?')[0].split('...'))
        history = ['0'*40, 'a'*40, 'b'*40]
        if older == newer: status = 'identical'
        elif older in history and newer in history:
            status = 'ahead' if history.index(newer) > history.index(older) else 'behind'
        else: status = 'diverged'
        print(json.dumps(dict(status=status)))
    else: sys.exit(99)
elif name == 'ssh':
    if args[-1].startswith('mktemp'): print('/tmp/screenr-release.ABC123')
    elif args[-1] == 'cat /opt/screenr/current/REVISION':
        if os.environ.get('ACTIVE_EXIT'): sys.exit(1)
        count = sum('current/REVISION' in line for line in (base / 'calls').read_text().splitlines())
        print(os.environ['LATE_ACTIVE'] if os.environ.get('LATE_ACTIVE') and count > 1 else os.environ.get('ACTIVE_SHA', '0'*40))
    elif args[-1].startswith('sh -c'):
        sys.exit(int(os.environ.get('SSH_EXIT', '0')))
    elif args[-1].startswith('python3 '):
        sys.exit(int(os.environ.get('PRUNE_EXIT', '0')))
elif name == 'curl':
    if args[-1].endswith('health'): print(os.environ.get('HEALTH', '{"ok":true}'))
    elif args[-1].endswith('get-session'): print(os.environ.get('SESSION', 'null'))
    else: print(os.environ.get('LOGIN', 'Send sign-in code'))
'''


class DeploymentFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        (self.base / 'bin').mkdir()
        (self.base / 'ops').mkdir()
        (self.base / 'checked/ops').mkdir(parents=True)
        shutil.copy2(ROOT / 'bin/deploy-ci', self.base / 'bin/deploy-ci')
        for path in ROOT_SCRIPTS:
            shutil.copy2(ROOT / path, self.base / path)
            shutil.copy2(ROOT / path, self.base / 'checked' / path)
        self.commands = self.base / 'commands'
        self.commands.mkdir()
        fake = self.commands / 'command'
        fake.write_text(FAKE_COMMAND)
        fake.chmod(0o755)
        for name in ('git', 'gh', 'ssh', 'scp', 'curl'):
            (self.commands / name).symlink_to(fake)
        self.environment = {**os.environ, 'FIXTURE': str(self.base),
                            'SCREENR_DEPLOY_HOST': 'root@example.test',
                            'GITHUB_REPOSITORY': 'jubishop/screenr', 'GITHUB_RUN_ID': '123',
                            'GITHUB_SHA': REVISION, 'GITHUB_REF': 'refs/heads/main',
                            'GITHUB_EVENT_NAME': 'push',
                            'PATH': str(self.commands) + os.pathsep + os.environ['PATH']}
        for name in ('deploy-key', 'known-hosts'):
            (self.base / name).write_text('fixture')
        self.environment['SCREENR_DEPLOY_KEY_FILE'] = str(self.base / 'deploy-key')
        self.environment['SCREENR_DEPLOY_KNOWN_HOSTS_FILE'] = str(self.base / 'known-hosts')
        self.make_archive()

    def make_archive(self, revision=REVISION, extra=None, root_scripts=True):
        files = [('REVISION', revision), ('server.js', '// server')]
        if root_scripts:
            # The build job packages ops/ after third-party install scripts
            # run, so treat every archive copy of a root script as tampered.
            files += [('ops/deploy-release.sh', '#!/bin/sh\necho tampered-deployment\n'),
                      ('ops/activate.sh', '#!/bin/sh\necho tampered-activation\n'),
                      ('ops/prune-releases.py', 'print("tampered-cleanup")\n')]
        with tarfile.open(self.base / 'release.tar.gz', 'w:gz') as archive:
            for name, content in files:
                data = content.encode()
                member = tarfile.TarInfo('./' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)

    def execute(self, *args, **environment):
        return subprocess.run([str(self.base / 'bin' / self.command), *args], cwd=self.base,
                              env={**self.environment, **environment}, text=True,
                              capture_output=True, timeout=15)

    def calls(self):
        path = self.base / 'calls'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class CIDeploymentTests(DeploymentFixture):
    command = 'deploy-ci'

    def test_checked_manual_main_run_can_deploy(self):
        result = self.execute(GITHUB_EVENT_NAME='workflow_dispatch', RUN_EVENT='workflow_dispatch')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)
        self.assertTrue(any(call[0] == 'scp' for call in self.calls()))

    def test_checked_push_downloads_and_deploys_without_dispatching_again(self):
        result = self.execute(RUN_EVENT='push')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)
        calls = self.calls()
        for command in (['gh', 'run', 'download'], ['gh', 'api', '--method', 'DELETE']):
            self.assertTrue(any(call[:len(command)] == command for call in calls), command)
        self.assertFalse(any(call[:3] == ['gh', 'workflow', 'run'] for call in calls))
        self.assertTrue(any(call[0] == 'scp' for call in calls))
        self.assertTrue(any(call[0] == 'ssh' and call[-1].startswith('sh -c') for call in calls))
        self.assertEqual([call[-1] for call in calls if call[0] == 'curl'],
                         ['https://screenr.club/api/health', 'https://screenr.club/login',
                          'https://screenr.club/api/auth/get-session'])
        self.assertIn('https://screenr.club', result.stdout)
        for call in calls:
            if call[0] in ('ssh', 'scp'):
                self.assertIn('StrictHostKeyChecking=yes', call)
                self.assertIn('IdentitiesOnly=yes', call)
                self.assertIn(str(self.base / 'deploy-key'), call)

    def test_pull_request_feature_branch_and_failed_checks_never_contact_host(self):
        for environment in ({'GITHUB_EVENT_NAME': 'pull_request'},
                            {'GITHUB_EVENT_NAME': 'workflow_dispatch'},
                            {'GITHUB_REF': 'refs/heads/feature'},
                            {'RUN_EVENT': 'pull_request'}, {'RUN_EVENT': 'workflow_dispatch'}, {'RUN_BRANCH': 'feature'},
                            {'CHECK_RESULT': 'failure'}, {'CHECK_RESULT': 'skipped'},
                            {'RUN_SHA': 'b' * 40}, {'GITHUB_REPOSITORY': 'fork/screenr'},
                            {'CHECKOUT_SHA': 'b' * 40}, {'SCREENR_DEPLOY_KEY_FILE': ''},
                            {'SCREENR_DEPLOY_KNOWN_HOSTS_FILE': ''}):
            with self.subTest(environment=environment):
                result = self.execute(**environment)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertFalse(any(call[0] in ('ssh', 'scp') for call in self.calls()))

    def remote_commands(self):
        return [shlex.split(call[-1]) for call in self.calls() if call[0] == 'ssh']

    def assert_only_checked_root_scripts(self):
        checked = {path: (self.base / 'checked' / path).read_text() for path in ROOT_SCRIPTS}
        checksum = hashlib.sha256((self.base / 'release.tar.gz').read_bytes()).hexdigest()
        commands = self.remote_commands()
        self.assertFalse([command for command in commands
                          if any('tampered' in part or 'unchecked' in part for part in command)])
        self.assertEqual([command for command in commands if command[0] == 'sh'],
                         [['sh', '-c', checked['ops/deploy-release.sh'], 'deploy-release', REVISION,
                           checksum, '/tmp/screenr-release.ABC123', checked['ops/activate.sh']]])
        self.assertEqual([command for command in commands if command[0] == 'python3'],
                         [['python3', '-c', checked['ops/prune-releases.py'],
                           '/opt/screenr/releases/' + REVISION]])

    def test_checkout_changes_cannot_change_remote_scripts(self):
        result = self.execute(WORKTREE_DRIFT='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_only_checked_root_scripts()

    def test_tampered_archive_root_scripts_never_run(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_only_checked_root_scripts()

    def test_archive_without_root_scripts_still_deploys_checked_copies(self):
        self.make_archive(root_scripts=False)
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_only_checked_root_scripts()

    def test_unreadable_checked_script_never_contacts_host(self):
        for path in ROOT_SCRIPTS:
            with self.subTest(path=path):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(MISSING_CHECKED=path)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] in ('ssh', 'scp') for call in self.calls()))

    def uploaded(self):
        return any(call[0] == 'scp' or (call[0] == 'ssh' and call[-1].startswith(('mktemp', 'sh -c')))
                   for call in self.calls())

    def test_superseded_release_newer_than_production_deploys(self):
        # A newer push moved main while this run's checks ran.
        result = self.execute(MAIN_SHA='b' * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)
        self.assertIn('production has ' + '0' * 40, result.stdout)
        calls = self.calls()
        checks = [i for i, call in enumerate(calls) if call[-1].startswith('repos/jubishop/screenr/compare/')
                  or call[-1] == 'cat /opt/screenr/current/REVISION']
        upload = next(i for i, call in enumerate(calls) if call[0] == 'scp')
        activation = next(i for i, call in enumerate(calls) if call[0] == 'ssh' and call[-1].startswith('sh -c'))
        self.assertEqual(len(checks), 6)
        self.assertLess(max(checks[:3]), upload)
        self.assertTrue(upload < min(checks[3:]) and max(checks[3:]) < activation)

    def test_active_release_deploys_to_verify_health(self):
        result = self.execute(ACTIVE_SHA=REVISION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)

    def test_release_outside_main_never_contacts_host(self):
        # Main was rewound behind the release or rewritten without it.
        for main in ('0' * 40, 'f' * 40):
            with self.subTest(main=main):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(MAIN_SHA=main)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not in main', result.stderr)
                self.assertFalse(any(call[0] in ('ssh', 'scp') for call in self.calls()))

    def test_release_older_than_production_never_uploads(self):
        # Production is newer, or runs a revision this release does not contain.
        for active in ('b' * 40, 'f' * 40):
            with self.subTest(active=active):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(MAIN_SHA='b' * 40, ACTIVE_SHA=active)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('does not contain production revision ' + active, result.stderr)
                self.assertFalse(self.uploaded())

    def test_unverifiable_release_never_uploads(self):
        for environment in ({'COMPARE_FAIL': 'yes'}, {'ACTIVE_EXIT': '1'}, {'ACTIVE_SHA': 'unknown'}):
            with self.subTest(environment=environment):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(**environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Could not', result.stderr)
                self.assertFalse(self.uploaded())

    def test_push_during_upload_still_activates(self):
        result = self.execute(LATE_MAIN='b' * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('DEPLOY SUCCEEDED', result.stdout)

    def test_rewritten_main_or_newer_production_during_upload_stops_activation(self):
        for environment in ({'LATE_MAIN': 'f' * 40}, {'LATE_ACTIVE': 'b' * 40}):
            with self.subTest(environment=environment):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(**environment)
                self.assertNotEqual(result.returncode, 0)
                calls = self.calls()
                self.assertTrue(any(call[0] == 'scp' for call in calls))
                self.assertFalse(any(call[0] == 'ssh' and call[-1].startswith('sh -c') for call in calls))
                self.assertTrue(any(call[0] == 'ssh' and call[-1].startswith('rm -f') for call in calls))

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

    def test_failed_rollback_reports_production_down(self):
        # The remote scripts exit 69 only when no healthy release is running.
        for status, message in (('69', 'production is down'), ('1', 'Remote deployment exited with status 1')):
            with self.subTest(status=status):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(SSH_EXIT=status)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                if status != '69':
                    self.assertNotIn('production is down', result.stderr)
                # Report the outcome, not the remote script text.
                self.assertNotIn('Executed remotely', result.stderr)
                self.assertNotIn('DEPLOY SUCCEEDED', result.stdout)
                calls = self.calls()
                self.assertTrue(any(call[0] == 'ssh' and call[-1].startswith('rm -f') for call in calls))
                self.assertFalse(any(call[0] == 'ssh' and call[-1].startswith('python3 ') for call in calls))

    def test_failed_public_health_is_not_success(self):
        result = self.execute(HEALTH='{"ok":false}')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('DEPLOY SUCCEEDED', result.stdout)

    def test_broken_public_sign_in_route_is_not_success(self):
        # A signed-out session request returns JSON null; a broken auth route
        # answers with an error document or an unexpected body instead.
        for session in ('<!DOCTYPE html><title>500</title>', '{"session":{}}', ''):
            with self.subTest(session=session):
                result = self.execute(SESSION=session)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Public sign-in check failed', result.stderr)
                self.assertNotIn('DEPLOY SUCCEEDED', result.stdout)

    def test_retention_runs_only_after_all_public_checks_pass(self):
        for environment in ({'HEALTH': '{"ok":false}'}, {'LOGIN': 'unavailable'},
                            {'SESSION': 'unavailable'}, {}):
            with self.subTest(environment=environment):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(**environment)
                calls = self.calls()
                cleanup = [i for i, call in enumerate(calls)
                           if call[0] == 'ssh' and call[-1].startswith('python3 ')]
                if environment:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(cleanup, [])
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(len(cleanup), 1)
                    self.assertGreater(cleanup[0], max(i for i, call in enumerate(calls) if call[0] == 'curl'))

    def test_retention_failure_does_not_report_deployment_complete(self):
        result = self.execute(PRUNE_EXIT='1')
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
        # Faults affect the candidate, and also the restored release when
        # its migrations already broke it.
        broken() {
            [ "${ROLLBACK_BROKEN:-}" = yes ] || [ "$(command cat "$FIXTURE/current")" = "/opt/screenr/releases/$REVISION" ]
        }
        systemctl() {
            printf '%s\n' "$*" >> "$FIXTURE/systemctl"
            # systemctl is-active with multiple units succeeds if ANY is active.
            if [ "$1" = is-active ] && [ "$#" -eq 3 ] && [ "$3" = "${FAILED_UNIT:-}" ]; then return 1; fi
            if [ "$1" = start ] && [ "${FAIL_BACKUP:-}" = yes ]; then return 1; fi
            # A crash loop can use up the start limit, which refuses even a
            # manual restart until reset-failed clears it.
            if [ "$1" = reset-failed ]; then command rm -f "$FIXTURE/start-limit"; fi
            if [ "$1" = restart ] && [ -e "$FIXTURE/start-limit" ]; then return 1; fi
            if [ "$1" = show ]; then
                printf 'Id=fixture\nActiveState=active\n'
                # A crash-looping unit looks active at every check but
                # restarts between them.
                case " $* " in *" ${CRASHING_UNIT:-none} "*)
                    if broken; then
                        printf x >> "$FIXTURE/restarts"
                        : > "$FIXTURE/start-limit"
                    fi
                    : >> "$FIXTURE/restarts"
                    printf 'NRestarts=%s\n' "$(wc -c < "$FIXTURE/restarts")" ;;
                esac
            fi
        }
        readlink() { command cat "$FIXTURE/current"; }
        mkdir() { printf 'created\n' >> "$FIXTURE/events"; }
        tar() { [ "${FAIL_EXTRACT:-}" != yes ]; }
        touch() { :; }
        rm() { printf 'removed\n' >> "$FIXTURE/events"; }
        cat() { printf '%s\n' "$REVISION"; }
        test() {
            if [ "$1" = -f ]; then return 0; fi
            # An earlier failed rollback kept this revision's candidate.
            if [ "$1" = -e ] && [ "$2" = "/opt/screenr/releases/$REVISION/.deployment-pending" ]; then
                [ "${KEPT_CANDIDATE:-}" = yes ]; return
            fi
            command test "$@"
        }
        alias systemd-run=':'
        chown() { :; }
        ln() { printf '%s\n' "$2" > "$FIXTURE/pending"; }
        mv() { command cp "$FIXTURE/pending" "$FIXTURE/current"; }
        sleep() { printf '%s\n' "$1" >> "$FIXTURE/sleeps"; }
        curl() {
            if [ "${FAIL_HEALTH:-}" = yes ] && broken; then return 22; fi
            case "$*" in *' http://127.0.0.1:3060/api/auth/get-session')
                # Better Auth rejects each request while it cannot use the
                # database schema, so the route answers HTTP 500 and curl
                # exits 22. Also reject any answer other than null.
                if broken; then
                    case "${FAIL_SESSION:-}" in
                    error) return 22 ;;
                    body) printf '<!DOCTYPE html><title>Error</title>'; return ;;
                    esac
                fi
                printf 'null' ;;
            esac
        }
        sh() (
            # Release files are untrusted. Record and refuse any script file;
            # run only the checked script text passed by the CI helper.
            if [ "$1" != -c ]; then
                printf 'ran %s\n' "$1" >> "$FIXTURE/events"
                exit 1
            fi
            script=$2
            shift 3
            eval "$script"
        )
        set -- "$REVISION" "$CHECKSUM" /tmp/screenr-release.fixture "$ACTIVATION_SCRIPT"
        . "$DEPLOY"
        '''
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = '/opt/screenr/releases/' + REVISION
            initial = '' if environment.get('NO_PREVIOUS') else '/opt/screenr/releases/previous'
            (base / 'current').write_text(target if environment.get('ALREADY_ACTIVE') else initial)
            result = subprocess.run(['sh', '-c', harness], cwd=base, capture_output=True, text=True,
                                    env={**os.environ, 'FIXTURE': directory, 'REVISION': REVISION,
                                         'CHECKSUM': 'b' * 64,
                                         'ACTIVATION_SCRIPT': (ROOT / 'ops/activate.sh').read_text(),
                                         'DEPLOY': str(ROOT / 'ops/deploy-release.sh'), **environment}, timeout=5)
            log = {name: (base / name).read_text().splitlines() if (base / name).exists() else []
                   for name in ('systemctl', 'sleeps')}
            self.systemctl_calls, self.sleeps = log['systemctl'], log['sleeps']
            events = (base / 'events').read_text() if (base / 'events').exists() else ''
            current = (base / 'current').read_text().strip()
            return result, events, current

    def test_remote_activation_runs_and_preserves_active_release(self):
        result, events, current = self.execute_remote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('stayed active for 15 seconds without restarting.\nActivated ' + REVISION, result.stdout)
        self.assertNotIn('Rolled back', result.stdout + result.stderr)
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)
        self.assertNotIn('removed', events)

    def test_activation_runs_checked_script_not_release_copy(self):
        result, events, current = self.execute_remote(
            ACTIVATION_SCRIPT='echo checked-activation\nln -s "$1" /opt/screenr/current.new\nmv\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('checked-activation', result.stdout)
        self.assertNotIn('ran ', events)
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)

    def test_missing_activation_script_does_not_extract_or_activate(self):
        result, events, current = self.execute_remote(ACTIVATION_SCRIPT='')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events, '')
        self.assertEqual(current, '/opt/screenr/releases/previous')

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

    def assert_verified_rollback(self, result, events, current):
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Activated', result.stdout)
        self.assertIn('Activation failed. Rolled back to /opt/screenr/releases/previous', result.stderr)
        self.assertNotIn('ROLLBACK FAILED', result.stderr)
        self.assertIn('removed', events)
        self.assertEqual(current, '/opt/screenr/releases/previous')
        # The restored release passes the same health and stability checks.
        restart = max(i for i, call in enumerate(self.systemctl_calls) if call.startswith('restart'))
        snapshots = [call for call in self.systemctl_calls[restart:]
                     if call.startswith('show screenr-web screenr-worker')]
        self.assertGreaterEqual(len(snapshots), 2)

    def test_activation_failure_rolls_back_and_cleans_candidate(self):
        self.assert_verified_rollback(*self.execute_remote(FAIL_HEALTH='yes'))

    def test_failed_sign_in_route_fails_activation_and_rolls_back(self):
        # Database health passes, but Better Auth cannot use the schema. A
        # signed-out session request must answer HTTP 200 with null.
        for fault in ('error', 'body'):
            with self.subTest(fault=fault):
                self.assert_verified_rollback(*self.execute_remote(FAIL_SESSION=fault))

    def test_crash_looping_service_fails_activation_and_rolls_back(self):
        # Health and is-active pass at every check; only the restart record
        # shows that the unit keeps crashing on startup.
        for unit in ('screenr-worker', 'screenr-web'):
            with self.subTest(unit=unit):
                self.assert_verified_rollback(*self.execute_remote(CRASHING_UNIT=unit))
                # The rollback restart must not be refused by the start limit.
                restarts = [call for call in self.systemctl_calls if call.startswith(('restart', 'reset-failed'))]
                self.assertEqual(restarts[-2:], ['reset-failed screenr-web screenr-worker',
                                                 'restart screenr-web screenr-worker'])

    def test_unhealthy_rollback_reports_production_down_and_keeps_candidate(self):
        # Migrations already ran, so the restored release can fail too.
        for fault, reason in (({'FAIL_HEALTH': 'yes'}, 'did not pass the health checks within 20 attempts'),
                              ({'FAIL_SESSION': 'error'}, 'did not pass the health checks within 20 attempts'),
                              ({'CRASHING_UNIT': 'screenr-worker'}, 'stopped or restarted within 15 seconds')):
            with self.subTest(fault=fault):
                result, events, current = self.execute_remote(ROLLBACK_BROKEN='yes', **fault)
                self.assertEqual(result.returncode, 69)
                # The candidate and then the restored release fail the same checks.
                self.assertEqual(result.stderr.count(reason), 2)
                self.assertIn('Checking the restored release /opt/screenr/releases/previous.', result.stderr)
                self.assertIn('ROLLBACK FAILED: production is down.', result.stderr)
                self.assertNotIn('Rolled back to', result.stderr + result.stdout)
                self.assertNotIn('Activated', result.stdout)
                # The candidate already migrated the database; keep it for recovery.
                self.assertNotIn('removed', events)
                self.assertEqual(current, '/opt/screenr/releases/previous')

    def test_failed_activation_without_previous_release_reports_production_down(self):
        result, events, current = self.execute_remote(NO_PREVIOUS='yes', FAIL_HEALTH='yes')
        self.assertEqual(result.returncode, 69)
        self.assertIn('production is down', result.stderr)
        self.assertNotIn('Rolled back to', result.stderr)
        self.assertNotIn('removed', events)
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)

    def test_retry_replaces_candidate_kept_by_failed_rollback(self):
        result, events, current = self.execute_remote(KEPT_CANDIDATE='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        # Activation then creates the release's cache directory.
        self.assertEqual(events, 'removed\ncreated\ncreated\n')
        self.assertEqual(current, '/opt/screenr/releases/' + REVISION)

    def test_activation_waits_longer_than_a_restart_cycle(self):
        # A unit that crashes on startup is active between its restarts. A
        # cycle is the restart delay plus startup; allow startup as long as
        # the delay itself.
        delays = [int(re.search(r'^RestartSec=(\d+)$', (ROOT / f'ops/{unit}.service').read_text(), re.M)[1])
                  for unit in ('screenr-web', 'screenr-worker')]
        result, events, current = self.execute_remote()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreater(max((int(seconds) for seconds in self.sleeps), default=0), 2 * max(delays))
        snapshots = [call for call in self.systemctl_calls if call.startswith('show screenr-web screenr-worker')]
        self.assertGreaterEqual(len(snapshots), 2)
        for field in ('ActiveState', 'NRestarts', 'ActiveEnterTimestampMonotonic'):
            self.assertIn(f'-p {field}', snapshots[0])

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
