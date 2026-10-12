"""Run the deployment's host configuration step against disposable host files.

Deployment sends the checked source with `python3 -c`, so the tests run it the
same way, with a fake systemctl at the operating-system boundary.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UNITS = sorted(path.name for path in (ROOT / 'ops').iterdir()
               if path.name.startswith('screenr-') and path.suffix in ('.service', '.timer'))
# Other applications' sites in the shared Caddyfile, indented with tabs.
OTHER_SITES = 'kidsbank.example.test {\n\ttls /etc/caddy/certs/kidsbank.pem\n\treverse_proxy localhost:3000\n}\n'
# initdb writes defaults that the appended Screenr settings override.
INITDB_DEFAULTS = ("max_connections = 100\t\t\t# (change requires restart)\n"
                   "shared_buffers = 128MB\t\t\t# min 128kB\n#port = 5432\n")
FAKE_SYSTEMCTL = '''#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE/systemctl"
[ "$1" != "${FAIL_SYSTEMCTL:-}" ]
'''


class HostConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.units = self.base / 'systemd'
        self.units.mkdir()
        self.checked = {name: (ROOT / 'ops' / name).read_text() for name in UNITS}
        for name, content in self.checked.items():
            (self.units / name).write_text(content)
        for name in ('Caddyfile', 'postgresql.conf'):
            self.checked[name] = (ROOT / 'ops' / name).read_text()
        self.caddyfile = self.base / 'Caddyfile'
        self.caddyfile.write_text(OTHER_SITES + '\n' + self.checked['Caddyfile'] + '\nnews.example.test {\n}\n')
        self.postgresql = self.base / 'postgresql.conf'
        self.postgresql.write_text(INITDB_DEFAULTS + self.checked['postgresql.conf'])
        commands = self.base / 'commands'
        commands.mkdir()
        (commands / 'systemctl').write_text(FAKE_SYSTEMCTL)
        (commands / 'systemctl').chmod(0o755)
        self.environment = {**os.environ, 'FIXTURE': str(self.base),
                            'PATH': str(commands) + os.pathsep + os.environ['PATH']}

    def execute(self, **environment):
        source = (ROOT / 'ops/host-config.py').read_text()
        return subprocess.run([sys.executable, '-c', source, json.dumps(self.checked), str(self.units),
                               str(self.caddyfile), str(self.postgresql)],
                              env={**self.environment, **environment}, text=True,
                              capture_output=True, timeout=10)

    def systemctl(self):
        path = self.base / 'systemctl'
        return path.read_text().splitlines() if path.exists() else []

    def host_units(self):
        return {path.name: path.read_text() for path in self.units.iterdir()}

    def test_matching_host_changes_nothing(self):
        before = {path.name: path.stat().st_mtime_ns for path in self.units.iterdir()}
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Screenr systemd units match the release.', result.stdout)
        self.assertIn('match the release', result.stdout)
        self.assertEqual(self.systemctl(), [])
        self.assertEqual({path.name: path.stat().st_mtime_ns for path in self.units.iterdir()}, before)

    def test_changed_units_are_installed_and_systemd_reloaded(self):
        self.checked['screenr-web.service'] += '# Hardened\n'
        self.checked['screenr-backup.timer'] = self.checked['screenr-backup.timer'].replace('Persistent', '#')
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.host_units(), {name: self.checked[name] for name in UNITS})
        for name in ('screenr-web.service', 'screenr-backup.timer'):
            self.assertEqual((self.units / name).stat().st_mode & 0o777, 0o644)
            self.assertIn(name, result.stdout)
        self.assertNotIn('screenr-worker.service', result.stdout)
        # Existing timers keep their enablement; only systemd reloads.
        self.assertEqual(self.systemctl(), ['daemon-reload'])
        self.assertEqual(sorted(path.name for path in self.units.iterdir()), UNITS)

    def test_sandbox_rollout_installs_only_the_app_units(self):
        # The host still has the web and worker units from before their sandbox.
        sandbox = re.compile(r'^(PrivateDevices|ProtectKernel\w+|ProtectControlGroups|ProtectClock|'
                             r'ProtectHostname|ProtectProc|ProcSubset|Restrict\w+|LockPersonality|'
                             r'SystemCall\w+|CapabilityBoundingSet|InaccessiblePaths)=.*\n', re.M)
        for name in ('screenr-web.service', 'screenr-worker.service'):
            (self.units / name).write_text(sandbox.sub('', self.checked[name]))
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed screenr-web.service, screenr-worker.service from the release and reloaded '
                      'systemd.', result.stdout)
        self.assertEqual(self.host_units(), {name: self.checked[name] for name in UNITS})
        # Activation restarts both services under the new units.
        self.assertEqual(self.systemctl(), ['daemon-reload'])

    def test_new_timer_is_installed_and_enabled(self):
        for name in ('screenr-backup-size.service', 'screenr-backup-size.timer'):
            (self.units / name).unlink()
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.host_units(), {name: self.checked[name] for name in UNITS})
        # A new service runs only through its timer, which starts running now.
        self.assertEqual(self.systemctl(), ['daemon-reload', 'enable --now screenr-backup-size.timer'])
        self.assertIn('Enabled the new timer screenr-backup-size.timer.', result.stdout)

    def test_unit_linked_on_host_is_left_unchanged(self):
        # The owner masked this timer by hand.
        timer = self.units / 'screenr-restore-check.timer'
        timer.unlink()
        timer.symlink_to('/dev/null')
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(timer), '/dev/null')
        self.assertIn('screenr-restore-check.timer is a link on the host', result.stdout)
        self.assertEqual(self.systemctl(), [])

    def test_unit_missing_from_release_is_reported_not_removed(self):
        (self.units / 'screenr-retired.timer').write_text('[Timer]\n')
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.units / 'screenr-retired.timer').exists())
        self.assertIn('screenr-retired.timer', result.stdout)
        self.assertEqual(self.systemctl(), [])

    def assert_drift_changes_nothing(self, result, *messages):
        self.assertEqual(result.returncode, 1)
        self.assertIn('HOST CONFIGURATION DRIFT', result.stderr)
        for message in messages:
            self.assertIn(message, result.stderr)
        # Nothing is installed when the deployment stops.
        self.assertEqual(self.host_units()['screenr-web.service'], (ROOT / 'ops/screenr-web.service').read_text())
        self.assertEqual(self.systemctl(), [])

    def test_changed_screenr_site_fails_without_changing_the_host(self):
        shared = self.caddyfile.read_text()
        self.checked['screenr-web.service'] += '# Hardened\n'
        for name, host in (('changed directive', shared.replace('max_size 64KB', 'max_size 1MB')),
                           ('missing site', shared.replace('screenr.jubishop.com {', 'old.example.test {'))):
            with self.subTest(name=name):
                (self.base / 'systemctl').unlink(missing_ok=True)
                self.caddyfile.write_text(host)
                result = self.execute()
                site = 'screenr.club' if name == 'changed directive' else 'screenr.jubishop.com'
                self.assert_drift_changes_nothing(result, str(self.caddyfile), 'ops/Caddyfile', site,
                                                  f'caddy validate --config {self.caddyfile}',
                                                  'systemctl reload caddy')
                self.assertNotIn('postgresql.conf', result.stderr)
                self.assertEqual(self.caddyfile.read_text(), host)

    def test_comments_indentation_and_other_sites_are_not_drift(self):
        # The host kept an earlier comment and indents with tabs.
        host = self.caddyfile.read_text().replace('    ', '\t')
        self.caddyfile.write_text('# Installed during the 2026 domain cutover.\n' +
                                  host.replace('screenr.club {\n', 'screenr.club {\n\t# Hand note\n\n'))
        self.checked['Caddyfile'] = '# A rewritten header comment.\n' + self.checked['Caddyfile']
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Shared Caddy sites and PostgreSQL settings match the release.', result.stdout)

    def test_changed_postgresql_setting_fails_naming_the_setting(self):
        self.checked['postgresql.conf'] = self.checked['postgresql.conf'].replace(
            "work_mem = '2MB'", "work_mem = '4MB'") + 'jit = off\n'
        self.checked['screenr-web.service'] += '# Hardened\n'
        result = self.execute()
        self.assert_drift_changes_nothing(result, str(self.postgresql), 'ops/postgresql.conf', 'jit, work_mem',
                                          'systemctl restart screenr-db')
        self.assertNotIn('maintenance_work_mem', result.stderr)
        self.assertNotIn('Caddyfile', result.stderr)

    def test_both_drifts_are_reported_together(self):
        self.caddyfile.write_text(OTHER_SITES)
        self.postgresql.write_text(INITDB_DEFAULTS)
        result = self.execute()
        self.assert_drift_changes_nothing(result, str(self.caddyfile), str(self.postgresql),
                                          'screenr.club', 'shared_buffers')

    def test_last_postgresql_value_applies(self):
        # An earlier initdb default is overridden; quoting does not change a value.
        self.postgresql.write_text(self.postgresql.read_text().replace("shared_buffers = '32MB'",
                                                                       "shared_buffers = 64MB") +
                                   "SHARED_BUFFERS = 32MB   # restored by hand\n")
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.postgresql.write_text(self.postgresql.read_text() + "shared_buffers = '48MB'\n")
        result = self.execute()
        self.assertEqual(result.returncode, 1)
        self.assertIn('shared_buffers', result.stderr)

    def test_failed_systemd_reload_fails_the_step(self):
        self.checked['screenr-web.service'] += '# Hardened\n'
        result = self.execute(FAIL_SYSTEMCTL='daemon-reload')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Host configuration failed', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_unexpected_unit_names_are_refused(self):
        for name in ('../screenr-escape.service', 'screenr-web.socket', 'other.service'):
            with self.subTest(name=name):
                checked = dict(self.checked)
                self.checked[name] = '[Unit]\n'
                result = self.execute()
                self.checked = checked
                self.assertEqual(result.returncode, 1)
                self.assertIn('Unexpected', result.stderr)
                self.assertFalse((self.base / 'screenr-escape.service').exists())
                self.assertEqual(self.systemctl(), [])


if __name__ == '__main__':
    unittest.main()
