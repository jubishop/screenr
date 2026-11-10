#!/usr/bin/env python3
"""Fail when a run of a Screenr service ended unexpectedly, once for each crash loop.

Runs every five minutes. Reads systemd's message for each run of a service
that ended with a result other than success, such as exit-code, signal, or
oom-kill, from the journal since the previous check, or the last hour on the
first run. A deploy restart stops a service cleanly, which logs no such
message. A failure starts the failure alert, which emails the owner. A
service's unexpected ends less than an hour apart are one crash loop, reported
once. A service that is failed reached its restart limit, which its own
failure alert reports, so its ends send no second email.
"""
import argparse
from collections import Counter
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

UNIT = re.compile(r'screenr-[a-z0-9-]+\.service')
# A service's unexpected ends this close together, in microseconds, are one loop.
LOOP = 3600 * 1_000_000
# systemd's catalog ID for a unit's run that ended with a result other than
# success, which it logs with the result as UNIT_RESULT before any automatic
# restart. At the restart limit, systemd 255 logs the last run's again.
FAILED = 'd9b373ed55a64feb8242e02dbe79a49c'


def memory_check():
    """Load the journal reading of check-memory.py from the same deploy kit."""
    spec = importlib.util.spec_from_file_location(
        'check_memory', Path(__file__).resolve().with_name('check-memory.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def service(unit):
    """Return a service's state and its automatic restarts since it last started by hand."""
    output = subprocess.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,SubState,NRestarts'],
                            check=True, stdout=subprocess.PIPE, text=True, timeout=30).stdout
    state = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    if state.get('LoadState') != 'loaded':
        raise ValueError(f'{unit} is {state.get("LoadState") or "unknown"}, not loaded')
    return state


def moment(text):
    return round(datetime.datetime.fromisoformat(text).timestamp() * 1_000_000)


def iso(microseconds):
    return datetime.datetime.fromtimestamp(microseconds / 1_000_000, datetime.timezone.utc).isoformat()


def load(path):
    """Return the saved end of the previous check, and when each service last ended unexpectedly, in microseconds."""
    try:
        state = json.loads(path.read_text())
        ended = state['ended']
        if not isinstance(ended, dict) or not all(isinstance(value, str) for value in ended.values()):
            raise TypeError
        return moment(state['checked_until']), {unit: moment(value) for unit, value in ended.items()}
    except FileNotFoundError:
        return None, {}
    except (KeyError, TypeError, ValueError):
        raise ValueError(f'Invalid saved state in {path}') from None


def save(path, until, ended):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'checked_until': iso(until),
                       'ended': {unit: iso(at) for unit, at in sorted(ended.items()) if until - at <= LOOP}},
                      output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def utc(microseconds):
    return datetime.datetime.fromtimestamp(microseconds / 1_000_000, datetime.timezone.utc).strftime(
        '%Y-%m-%d %H:%M:%S UTC')


def times(count):
    return 'once' if count == 1 else f'{count} times'


def describe(runs, at, state):
    """Describe a service's runs that ended unexpectedly, at their sorted times, and its state now."""
    results = Counter(str(entry.get('UNIT_RESULT') or 'unknown') for entry in runs).most_common()
    how = (results[0][0] if len(results) == 1
           else ' and '.join(f'{result} {times(count)}' for result, count in results))
    when = f'at {utc(at[0])}' if len(at) == 1 else f'between {utc(at[0])} and {utc(at[-1])}'
    restarts = state.get('NRestarts', '')
    return (f'{len(at)} run{"s" if len(at) > 1 else ""} ended unexpectedly, with {how}, {when}. '
            f'systemd has restarted it {times(int(restarts)) if restarts.isdigit() else "an unknown number of times"} '
            f'since it last started by hand, and it is {state.get("ActiveState") or "unknown"} '
            f'({state.get("SubState") or "unknown"}).')


def inspect(journal, states, since, until, ended):
    """Return the summary lines and the problems, and record when each service last ended unexpectedly."""
    entries = journal.window(since, until, '_PID=1', f'MESSAGE_ID={FAILED}', *(f'UNIT={unit}' for unit in states))
    runs = {unit: {} for unit in states}
    for entry in entries:
        unit = entry.get('UNIT')
        if unit in runs:
            # Each run counts once, though the restart limit logs its last run twice.
            runs[unit].setdefault(entry.get('INVOCATION_ID') or entry.get('__CURSOR'), entry)
    summary, problems = [], []
    for unit, state in states.items():
        if not runs[unit]:
            continue
        at = sorted(int(entry['__REALTIME_TIMESTAMP']) for entry in runs[unit].values())
        line = f'{unit}: {describe(runs[unit].values(), at, state)}'
        previous, ended[unit] = ended.get(unit), at[-1]
        if previous is not None and at[0] - previous <= LOOP:
            summary.append(f'{line} It is part of a crash loop already reported.')
        elif (state.get('ActiveState'), state.get('SubState')) == ('failed', 'failed'):
            summary.append(f'{line} It reached its restart limit, which its failure alert reports.')
        else:
            problems.append(line)
    return summary, problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true',
                        help='report without saving where this check stopped or what it found')
    parser.add_argument('units', nargs='+', metavar='unit')
    arguments = parser.parse_args()
    for unit in arguments.units:
        if not UNIT.fullmatch(unit):
            print(f'Refusing to check {unit!r}: not a Screenr service', file=sys.stderr)
            return 2
    path = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/screenr-crash-check')) / 'state.json'
    try:
        journal = memory_check()
        until = journal.microseconds(time.time())
        since, ended = load(path)
        if since is None or since > until:
            since = until - LOOP
        states = {unit: service(unit) for unit in arguments.units}
        # Without the systemd-journal group, journalctl can show no entries and
        # still succeed. PID 1 logs every day, so the journal always has some.
        if not journal.journal('--lines=1', '_PID=1'):
            raise ValueError('cannot read the system journal; the check needs the systemd-journal group')
        summary, problems = inspect(journal, states, since, until, ended)
        if not arguments.dry_run:
            save(path, until, ended)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Crash check failed: {error}', file=sys.stderr)
        return 1
    for line in summary:
        print(line)
    if problems:
        for line in problems:
            print(line, file=sys.stderr)
        return 1
    if not summary:
        print(f'No Screenr service ended unexpectedly since {utc(since)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
