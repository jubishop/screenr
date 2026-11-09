"""Python tests wait for their processes under one bound that only a hang reaches."""
import ast
from pathlib import Path
import re
import unittest

from _process_waits import HANG_SECONDS

ROOT = Path(__file__).resolve().parents[1]
# subprocess functions and Popen methods that take a timeout.
WAITS = {'run', 'call', 'check_call', 'check_output', 'communicate', 'wait'}


class ProcessWaitTests(unittest.TestCase):
    maxDiff = None

    def test_every_process_wait_uses_the_hang_bound(self):
        # A bound sized for an idle Mac fails the test when parallel checks load it.
        waits, others = 0, []
        for path in sorted((ROOT / 'tests').glob('*.py')):
            for node in ast.walk(ast.parse(path.read_text(), str(path))):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in WAITS):
                    continue
                for keyword in node.keywords:
                    if keyword.arg == 'timeout':
                        waits += 1
                        if not (isinstance(keyword.value, ast.Name) and keyword.value.id == 'HANG_SECONDS'):
                            others.append(f'{path.name}:{node.lineno}: timeout={ast.unparse(keyword.value)}')
        self.assertGreater(waits, 0)
        self.assertEqual(others, [], 'Pass HANG_SECONDS from tests/_process_waits.py as the timeout.')

    def test_a_hung_process_fails_its_test_before_ci_cancels_the_job(self):
        # The static job runs the Python tests. Its other checks take about 3
        # minutes, so one hang still reports which test hung.
        workflow = (ROOT / '.github/workflows/check.yml').read_text()
        job = re.search(r'^  static:\n(?:(?:    .*)?\n)*', workflow, re.M)[0]
        self.assertIn('run: bin/check-application --part static\n', job)
        limit = re.search(r'^    timeout-minutes: (\d+)$', job, re.M)
        self.assertLessEqual(HANG_SECONDS, int(limit[1]) * 60 - 5 * 60)


if __name__ == '__main__':
    unittest.main()
