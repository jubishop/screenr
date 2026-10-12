"""Check how the Screenr systemd units order themselves and report readiness."""
from pathlib import Path
import unittest

from test_failure_alert import unit_file

ROOT = Path(__file__).resolve().parents[1]
SERVICES = sorted(path.name for path in (ROOT / 'ops').glob('screenr-*.service'))


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


if __name__ == '__main__':
    unittest.main()
