#!/usr/bin/env python3
"""Fail when the newest Screenr backup snapshot is more than 30 hours old.

Reads only snapshot metadata through restic, using the backup environment.
"""
import datetime
import json
import re
import subprocess
import sys
import time

MAX_AGE = 30 * 3600
# Seconds before listing again after restic fails, so a brief storage outage,
# such as R2 answering 502 Bad Gateway, sends no failure alert.
RETRY_DELAY = 60
SNAPSHOTS = ('restic', 'snapshots', '--no-lock', '--host', 'bishop', '--tag', 'screenr',
             '--latest', '1', '--json')
# restic writes Go RFC 3339 times, which can carry nanoseconds.
TIME = re.compile(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)')


def snapshot_time(snapshot):
    value = snapshot.get('time') if isinstance(snapshot, dict) else None
    match = TIME.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError('Invalid snapshot time in restic output')
    seconds, fraction, zone = match.groups()
    moment = datetime.datetime.fromisoformat(seconds + ('+00:00' if zone == 'Z' else zone))
    return moment.timestamp() + float('0.' + (fraction or '0'))


def list_snapshots():
    return subprocess.run(SNAPSHOTS, check=True, stdout=subprocess.PIPE, text=True, timeout=300).stdout


def newest_backup():
    """Return the newest snapshot's short ID and its age in seconds."""
    try:
        output = list_snapshots()
    except subprocess.SubprocessError as error:
        print(f'Listing snapshots failed ({error}); retrying in {RETRY_DELAY} seconds', file=sys.stderr)
        time.sleep(RETRY_DELAY)
        output = list_snapshots()
    snapshots = json.loads(output)
    if not isinstance(snapshots, list) or not snapshots:
        raise ValueError('No Screenr backup snapshots found')
    newest = max(snapshots, key=snapshot_time)
    return str(newest.get('short_id', 'unknown')), time.time() - snapshot_time(newest)


def main():
    try:
        snapshot, age = newest_backup()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Backup age check failed: {error}', file=sys.stderr)
        return 1
    if age > MAX_AGE:
        print(f'Newest Screenr backup {snapshot} is {age / 3600:.1f} hours old, '
              f'over the {MAX_AGE // 3600}-hour limit', file=sys.stderr)
        return 1
    print(f'Newest Screenr backup {snapshot} is {age / 3600:.1f} hours old')
    return 0


if __name__ == '__main__':
    sys.exit(main())
