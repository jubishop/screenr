"""Check the systemd sandbox of the units and commands that run Screenr code.

Deployment installs these units and activation restarts the web and worker
under them, with no automatic return to the previous units. A setting that
stops either service therefore takes production down, so these tests keep what
the services need open: loopback PostgreSQL, HTTPS to Resend and TMDB, the Node
runtime, the release, the web's Next cache, and its shared poster cache.

Every other Screenr unit except the PostgreSQL server, and
ops/run-release-script.sh, which runs a release's maintenance scripts outside
the units, apply the worker's sandbox (#306). The worker's unit is the one
source of these settings: systemd units cannot include shared settings, so
these tests require every copy to match it.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from _process_waits import HANG_SECONDS

ROOT = Path(__file__).resolve().parents[1]
APPS = ('screenr-web.service', 'screenr-worker.service')
SOURCE = 'screenr-worker.service'
# The PostgreSQL server runs no Screenr scripts and keeps its own settings.
DATABASE = 'screenr-db.service'
# The backup, restore check, backup checks, PostgreSQL update check, memory and
# crash checks, and alerts.
JOBS = sorted(path.name for path in (ROOT / 'ops').glob('screenr-*.service')
              if path.name not in APPS + (DATABASE,))
RUNNER = ROOT / 'ops' / 'run-release-script.sh'
NODE = '/opt/screenr/node/bin/node'
# The active release's Next cache, which belongs to its build.
RELEASE_CACHE = '/opt/screenr/current/.next/cache'
# The settings that let a unit write files.
WRITABLE = ('ReadWritePaths', 'CacheDirectory', 'CacheDirectoryMode', 'BindPaths')
# The decided sandbox for both units (#118).
DECIDED = {
    'NoNewPrivileges': 'true',
    'PrivateTmp': 'true',
    'PrivateDevices': 'true',
    'ProtectSystem': 'strict',
    'ProtectHome': 'true',
    'ProtectKernelTunables': 'true',
    'ProtectKernelModules': 'true',
    'ProtectKernelLogs': 'true',
    'ProtectControlGroups': 'true',
    'ProtectClock': 'true',
    'ProtectHostname': 'true',
    'ProtectProc': 'invisible',
    'ProcSubset': 'pid',
    'RestrictNamespaces': 'true',
    'RestrictSUIDSGID': 'true',
    'LockPersonality': 'true',
    'SystemCallFilter': '@system-service',
    'SystemCallArchitectures': 'native',
    'CapabilityBoundingSet': '',
}
# Every setting of the shared sandbox.
SANDBOX = set(DECIDED) | {'RestrictAddressFamilies', 'RestrictRealtime', 'SystemCallErrorNumber',
                          'InaccessiblePaths', 'UMask'}
# Settings that would cut off loopback PostgreSQL, R2, Resend, or TMDB.
NETWORK_LIMITS = ('PrivateNetwork', 'IPAddressDeny', 'IPAddressAllow', 'RestrictNetworkInterfaces')
# Paths that the services, release scripts, and jobs read or write at run time:
# the release and Node runtime, settings, TLS roots and DNS, the deploy kit and
# restic, the backup workspace, the database socket, D-Bus for the systemctl of
# the alert, the memory and crash checks, and each service's memory peak read,
# apt's package lists and the dynamic user's state for the update check, and
# the journal and state of the memory and crash checks.
NEEDED = ('/opt/screenr', '/opt/node', '/etc/screenr', '/usr', '/etc/ssl', '/etc/resolv.conf',
          '/var/lib/screenr-backup', '/run/screenr-db', '/run/dbus', '/run/systemd', '/var/lib/apt',
          '/var/lib/dpkg', '/etc/apt', '/var/lib/private', '/var/log/journal', '/run/log/journal',
          '/var/lib/screenr-memory-check', '/var/lib/screenr-crash-check')
# Other applications' directories on the shared host.
OTHER_APPLICATIONS = ('/opt/health', '/opt/kidsbank', '/opt/news', '/opt/trading', '/etc/caddy')
# The Markdown that the runbook test scans.
RUNBOOKS = ('docs/**/*.md', 'memory/**/*.md', '*.md')
# Records the arguments systemd-run receives and exits with FIXTURE_STATUS.
FAKE_SYSTEMD_RUN = '''#!/usr/bin/env python3
import json, os, sys
with open(os.path.join(os.environ['FIXTURE'], 'systemd-run.json'), 'w') as log:
    json.dump(sys.argv[1:], log)
sys.exit(int(os.environ.get('FIXTURE_STATUS', '0')))
'''


def service(name):
    """Parse a unit's [Service] section into {key: [values]}."""
    settings, section = {}, None
    for line in (ROOT / 'ops' / name).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            section = line
        elif section == '[Service]':
            key, value = line.split('=', 1)
            settings.setdefault(key, []).append(value)
    return settings


def words(settings, key):
    return ' '.join(settings.get(key, [])).split()


def sandbox(settings):
    return {key: settings.get(key) for key in SANDBOX}


def triggers(workflow):
    """Return a workflow's on: block, without comment lines."""
    text = re.sub(r'^ *#.*\n', '', workflow.read_text(), flags=re.M)
    return 'on:\n' + text.split('\non:\n', 1)[1].split('\n\n', 1)[0] + '\n'


def run_release_script(*arguments, status=0):
    """Run ops/run-release-script.sh with a fake systemd-run, and return its
    result, options, -p properties as {key: [values]}, and command."""
    with tempfile.TemporaryDirectory() as directory:
        fake = Path(directory) / 'systemd-run'
        fake.write_text(FAKE_SYSTEMD_RUN)
        fake.chmod(0o755)
        result = subprocess.run(['sh', str(RUNNER), *arguments], capture_output=True, text=True,
                                env={**os.environ, 'FIXTURE': directory, 'FIXTURE_STATUS': str(status),
                                     'PATH': directory + os.pathsep + os.environ['PATH']}, timeout=HANG_SECONDS)
        log = Path(directory) / 'systemd-run.json'
        argv = json.loads(log.read_text()) if log.exists() else []
    command = argv.index(NODE) if NODE in argv else len(argv)
    options, properties = [], {}
    pending = iter(argv[:command])
    for option in pending:
        if option == '-p':
            key, value = next(pending).split('=', 1)
            properties.setdefault(key, []).append(value)
        else:
            options.append(option)
    return result, options, properties, argv[command:]


class AppSandboxTests(unittest.TestCase):
    def test_web_and_worker_apply_the_decided_sandbox(self):
        for name in APPS:
            settings = service(name)
            for key, value in DECIDED.items():
                with self.subTest(unit=name, setting=key):
                    self.assertEqual(settings.get(key), [value])

    def test_web_and_worker_share_one_sandbox(self):
        # Only the web writes files: Next's caches.
        web, worker = service('screenr-web.service'), service('screenr-worker.service')
        self.assertEqual(web.pop('ReadWritePaths'), [RELEASE_CACHE])
        for key in WRITABLE:
            self.assertNotIn(key, worker)
        self.assertEqual(sandbox(web), sandbox(worker))

    def test_web_keeps_optimized_posters_in_one_directory_for_every_release(self):
        # Next always writes optimized posters to .next/cache/images, and
        # activation gives each release an empty .next/cache. The web mounts
        # one cache directory there instead, so a deploy or rollback keeps the
        # posters already optimized, and retained releases hold no copies
        # (#423). Image cache keys hold only the URL, width, quality, and
        # format, so releases can share entries; the rest of .next/cache
        # belongs to one build.
        web = service('screenr-web.service')
        # systemd creates /var/cache/screenr/images before each start, owned
        # by screenr, private to it, and writable in the sandbox.
        self.assertEqual(web.get('CacheDirectory'), ['screenr/images'])
        self.assertEqual(web.get('CacheDirectoryMode'), ['0700'])
        self.assertEqual(web.get('BindPaths'), ['/var/cache/screenr/images:' + RELEASE_CACHE + '/images'])

    def test_sandbox_keeps_network_access_the_services_need(self):
        for name in APPS:
            with self.subTest(unit=name):
                settings = service(name)
                # PostgreSQL listens on 127.0.0.1:5439; Resend and TMDB need
                # outbound HTTPS. A private network would cut off both.
                self.assertEqual(sorted(words(settings, 'RestrictAddressFamilies')),
                                 ['AF_INET', 'AF_INET6', 'AF_UNIX'])
                for key in NETWORK_LIMITS:
                    self.assertNotIn(key, settings)
        # Without HOSTNAME, Next lists the network interfaces at startup, which
        # needs the netlink sockets that the sandbox refuses.
        self.assertIn('HOSTNAME=127.0.0.1', service('screenr-web.service')['Environment'])

    def test_sandbox_keeps_the_runtime_working(self):
        for name in APPS:
            with self.subTest(unit=name):
                settings = service(name)
                # V8's JIT writes executable memory.
                self.assertNotIn('MemoryDenyWriteExecute', settings)
                # A syscall outside the filter fails with EPERM instead of
                # killing the service.
                self.assertEqual(settings.get('SystemCallErrorNumber'), ['EPERM'])
                self.assertEqual(settings['User'], ['screenr'])
                self.assertTrue(settings['ExecStart'][0].startswith(NODE + ' '))
                for key in ('PrivateUsers', 'DynamicUser', 'TemporaryFileSystem', 'ReadOnlyPaths'):
                    self.assertNotIn(key, settings)

    def test_other_applications_are_hidden_and_screenr_paths_are_not(self):
        # Every other copy of the sandbox matches the worker's list.
        hidden = words(service(SOURCE), 'InaccessiblePaths')
        # A missing path would fail the unit; '-' ignores it.
        self.assertTrue(hidden and all(path.startswith('-/') for path in hidden), hidden)
        paths = [path[1:] for path in hidden]
        for path in OTHER_APPLICATIONS:
            self.assertIn(path, paths)
        for path in paths:
            for needed in NEEDED:
                self.assertFalse(needed == path or needed.startswith(path + '/')
                                 or path.startswith(needed + '/'), (path, needed))


class JobSandboxTests(unittest.TestCase):
    """The job units run root-installed kit scripts and system programs as
    screenr-db or a dynamic user, with the backup secrets. The worker's sandbox
    leaves them what they need: restic and its cache, HTTPS to R2 and Resend,
    the database socket, systemd's D-Bus API for the alert and the memory and
    crash checks, and the journal for those checks."""

    def test_jobs_cover_every_unit_but_the_application_and_database(self):
        self.assertLessEqual({'screenr-alert@.service', 'screenr-backup-age.service', 'screenr-backup-size.service',
                              'screenr-backup.service', 'screenr-memory-check.service', 'screenr-crash-check.service',
                              'screenr-postgresql-updates.service', 'screenr-restore-check.service'}, set(JOBS))

    def test_jobs_apply_the_worker_sandbox(self):
        expected = sandbox(service(SOURCE))
        for name in JOBS:
            with self.subTest(unit=name):
                self.assertEqual(sandbox(service(name)), expected)

    def test_jobs_keep_the_network_and_state_they_need(self):
        for name in JOBS:
            with self.subTest(unit=name):
                settings = service(name)
                for key in NETWORK_LIMITS:
                    self.assertNotIn(key, settings)
                self.assertNotEqual(settings.get('User'), ['screenr'])
        # The backup, restore check, and backup checks keep restic's cache and
        # the dump in the backup workspace.
        for name in ('screenr-backup.service', 'screenr-restore-check.service', 'screenr-backup-age.service',
                     'screenr-backup-size.service'):
            with self.subTest(unit=name):
                settings = service(name)
                self.assertEqual(settings['StateDirectory'], ['screenr-backup'])
                self.assertEqual(settings['ReadWritePaths'], ['/var/lib/screenr-backup'])


class ReleaseScriptSandboxTests(unittest.TestCase):
    """Activation's configuration check and migrations, and the runbooks'
    one-off scripts, run release code as screenr through
    ops/run-release-script.sh."""

    RELEASE = '/opt/screenr/releases/' + 'a' * 40

    def test_release_scripts_run_in_the_worker_sandbox(self):
        result, options, properties, command = run_release_script(self.RELEASE, 'scripts/migrate.ts')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sandbox(properties), sandbox(service(SOURCE)))
        # V8's JIT writes executable memory, release scripts write no files,
        # and migrations need loopback PostgreSQL.
        for key in ('MemoryDenyWriteExecute', 'ReadWritePaths', *NETWORK_LIMITS):
            self.assertNotIn(key, properties)
        self.assertEqual(set(properties) - SANDBOX, {'EnvironmentFile', 'Environment'})
        self.assertEqual(properties['EnvironmentFile'], ['/etc/screenr/app.env'])
        self.assertEqual(properties['Environment'], ['NODE_ENV=production'])
        # Waiting with piped output gives activation the script's output and
        # exit status.
        for option in ('--wait', '--pipe', '--collect', '--uid=screenr', '--gid=screenr',
                       '--working-directory=' + self.RELEASE):
            self.assertIn(option, options)
        self.assertEqual(command, [NODE, '--import', 'tsx', 'scripts/migrate.ts'])

    def test_arguments_and_exit_status_pass_through(self):
        code = 'console.log("one argument")'
        result, _, _, command = run_release_script('/opt/screenr/current', '--input-type=module', '-e', code,
                                                   status=3)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(command, [NODE, '--import', 'tsx', '--input-type=module', '-e', code])

    def test_missing_script_runs_nothing(self):
        for arguments in ((), (self.RELEASE,)):
            with self.subTest(arguments=arguments):
                result, options, _, command = run_release_script(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual((options, command), ([], []))

    def test_activation_runs_release_scripts_only_through_the_runner(self):
        # tests/test_deploy.py runs activation and records each script it
        # passes to the runner.
        self.assertNotIn('systemd-run', (ROOT / 'ops' / 'activate.sh').read_text())

    def test_runbooks_run_release_code_only_through_the_runner(self):
        # A documented systemd-run as screenr would run release code outside
        # the sandbox. screenr-db runs only system programs and kit scripts.
        unsandboxed = re.compile(r'(--uid=|User=|-u )screenr(?![\w-])')
        sources = [*(path for runbooks in RUNBOOKS for path in ROOT.glob(runbooks)),
                   *(path for path in (ROOT / 'ops').iterdir()
                     if path.is_file() and path.name not in APPS + (RUNNER.name,))]
        for path in sources:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertIsNone(unsandboxed.search(path.read_text()))

    def test_ci_runs_for_every_change(self):
        # Markdown changed alone can fail the checks: the runbook test reads
        # the pages in RUNBOOKS (#371), and the document checks read every
        # tracked Markdown file (#439). Skipping such a change would surface its
        # failure in the next unrelated pull request, so CI's triggers filter
        # no paths, and every pull request and push to main runs (#470).
        self.assertEqual(triggers(ROOT / '.github' / 'workflows' / 'check.yml'),
                         'on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n')


if __name__ == '__main__':
    unittest.main()
