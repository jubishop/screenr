"""Check how the Screenr systemd units order themselves, report readiness, and stop."""
from pathlib import Path
import sys
import unittest

from test_failure_alert import unit_file

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bin'))
from _deploy_kit import SCRIPTS  # noqa: E402

SERVICES = sorted(path.name for path in (ROOT / 'ops').glob('screenr-*.service'))
KIT = '/usr/local/lib/screenr-deploy/'
# Only these run as screenr, from the release the deploy key uploads.
APPLICATION = ('screenr-web.service', 'screenr-worker.service')


def words(unit, key):
    return ' '.join(unit_file(unit).get('Unit', {}).get(key, [])).split()


class UnitDependencyTests(unittest.TestCase):
    def test_units_ordered_after_the_network_also_pull_it_in(self):
        # After= only orders units. Without Wants=, nothing has to start
        # network-online.target, and the unit can start before the network.
        ordered = [unit for unit in SERVICES if 'network-online.target' in words(unit, 'After')]
        self.assertLessEqual({'screenr-web.service', 'screenr-worker.service', 'screenr-backup.service',
                              'screenr-restore-check.service'}, set(ordered))
        for unit in ordered:
            with self.subTest(unit=unit):
                self.assertIn('network-online.target', words(unit, 'Wants'))

    def test_database_dependents_start_once_postgresql_accepts_connections(self):
        service = unit_file('screenr-db.service')['Service']
        # The postmaster is the main process, and it notifies systemd itself
        # once it accepts connections.
        self.assertEqual(service.get('Type'), ['notify'])
        self.assertTrue(service['ExecStart'][0].startswith('/usr/lib/postgresql/18/bin/postgres '))
        # Crash recovery can outlast systemd's 90-second default. A start
        # timeout would stop recovery and restart it from the beginning.
        self.assertEqual(service.get('TimeoutStartSec'), ['infinity'])
        dependents = [unit for unit in SERVICES if 'screenr-db.service' in words(unit, 'Requires')]
        self.assertLessEqual({'screenr-web.service', 'screenr-worker.service'}, set(dependents))
        for unit in dependents:
            with self.subTest(unit=unit):
                self.assertIn('screenr-db.service', words(unit, 'After'))

    def test_postgresql_stops_its_own_processes_in_order(self):
        service = unit_file('screenr-db.service')['Service']
        # Only the postmaster receives SIGINT, PostgreSQL's fast shutdown, and
        # it stops its child processes in order. The default control-group
        # mode would send the signal to every PostgreSQL process at once.
        self.assertEqual(service.get('KillMode'), ['mixed'])
        self.assertEqual(service.get('KillSignal'), ['SIGINT'])
        # systemd kills the processes that remain after a finite stop timeout.
        self.assertNotIn('SendSIGKILL', service)
        self.assertRegex(service['TimeoutStopSec'][0], r'^[1-9][0-9]*$')


class PrivilegedScriptTests(unittest.TestCase):
    """The deploy key can upload any release, so units with the database user, the
    backup secrets, or a dynamic user run only system programs and the root-installed
    deploy kit, never files from the release."""

    def test_privileged_units_run_only_system_programs_and_kit_scripts(self):
        for unit in sorted(set(SERVICES) - set(APPLICATION)):
            service = unit_file(unit)['Service']
            commands = [line for key, lines in service.items() if key.startswith('Exec') for line in lines]
            self.assertTrue(commands, unit)
            for command in commands:
                with self.subTest(unit=unit, command=command):
                    words = command.lstrip('-@:+!').split()
                    self.assertTrue(words[0].startswith(('/usr/bin/', '/bin/', '/usr/lib/postgresql/')), command)
                    self.assertNotIn('/opt/screenr', command)
                    for word in words[1:]:
                        if word.startswith('/'):
                            self.assertTrue(word.startswith(KIT) or word.startswith('/var/lib/screenr/'), word)
                            if word.startswith(KIT):
                                self.assertIn(word.removeprefix(KIT), SCRIPTS)

    def test_kit_scripts_call_other_scripts_only_from_the_kit(self):
        for name in SCRIPTS:
            text = (ROOT / 'ops' / name).read_text()
            with self.subTest(script=name):
                self.assertNotIn('/opt/screenr/current/ops', text)

    def test_application_units_run_release_code_as_screenr(self):
        for unit in APPLICATION:
            with self.subTest(unit=unit):
                self.assertEqual(unit_file(unit)['Service']['User'], ['screenr'])


if __name__ == '__main__':
    unittest.main()
