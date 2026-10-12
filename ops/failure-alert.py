#!/usr/bin/env python3
"""Email the owner through Resend when a Screenr unit fails and systemd stops retrying it.

Each monitored unit starts screenr-alert@<unit>.service through OnFailure=.
systemd also does that before each automatic restart of a service with
Restart=, so this sends only when the unit stays failed: a failed job, or a
service that reached its restart limit.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

UNIT = re.compile(r'screenr-[a-z0-9-]+\.service')
JOBS = {
    'screenr-backup.service': (
        'daily backup failed',
        'The daily encrypted database backup failed. Deployments also run this backup and '
        'fail until it succeeds.'),
    'screenr-restore-check.service': (
        'weekly restore check failed',
        'The weekly restore check failed. The newest backup may be over 30 hours old, '
        'unreadable, or unable to restore.'),
    'screenr-backup-age.service': (
        'no backup in the last 30 hours',
        'The daily stale-backup check found no backup from the last 30 hours, or could not '
        'read the backup snapshots. Backups may have stopped running.'),
    'screenr-backup-size.service': (
        'backup storage check failed',
        'The backup storage check could not measure the R2 backup bucket, save its state, or '
        'email its 1 GB warning. Backups and deployments are unaffected, and it retries at its '
        'next run within six hours. If the journal says to reconcile, follow the backup '
        'storage warning steps in docs/deployment.md before rerunning it.'),
    'screenr-postgresql-updates.service': (
        'PostgreSQL update check failed',
        'The daily PostgreSQL update check could not list pending package updates, save its '
        'state, or email its notice. A pending PostgreSQL update may go unreported.'),
}
SERVICES = {
    'screenr-web.service': 'web application',
    'screenr-worker.service': 'email worker',
    'screenr-db.service': 'database',
}


def setting(name):
    value = os.environ.get(name, '').strip()
    if not value:
        raise ValueError(f'Missing {name} in backup environment')
    return value


def unit_state(unit):
    output = subprocess.run(['systemctl', 'show', unit,
                             '--property=ActiveState,SubState,Result,NRestarts'],
                            check=True, stdout=subprocess.PIPE, text=True, timeout=30).stdout
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def compose(unit, state):
    details = f'Unit: {unit}\nResult: {state.get("Result") or "unknown"}\n'
    if state.get('Result') == 'timeout':
        details += 'It ran past its time limit, so systemd stopped it.\n'
    if unit in SERVICES:
        name = SERVICES[unit]
        subject = f'{name} stopped'
        # At the start limit, systemd 255 reports the last crash's result, not start-limit-hit.
        summary = (f'The Screenr {name} ({unit}) failed, and systemd will not restart it again. '
                   'Usually it kept failing and reached its restart limit.')
        details += f'Automatic restarts: {state.get("NRestarts") or "unknown"}\n'
        recovery = (f'After fixing the cause, run: systemctl reset-failed {unit} && '
                    f'systemctl start {unit}')
    else:
        subject, summary = JOBS.get(unit, (f'{unit} failed', f'{unit} failed.'))
        recovery = f'After fixing the cause, rerun it: systemctl start {unit}'
    text = (f'{summary}\n\n{details}Host: {socket.gethostname()}\n\n'
            f'Inspect: journalctl -u {unit} -n 100\n{recovery}\n\n'
            'This alert is sent once each time systemd stops retrying the unit.')
    return 'Screenr alert: ' + subject, text


def send(message, api_key):
    key = 'screenr-failure-alert/' + str(uuid.uuid4())
    for attempt in range(3):
        request = urllib.request.Request('https://api.resend.com/emails',
            data=json.dumps(message).encode(), headers={
                'Authorization': 'Bearer ' + api_key,
                'Content-Type': 'application/json',
                'User-Agent': 'Screenr-failure-alert/1',
                # Retries reuse the key, so a lost response cannot send twice.
                'Idempotency-Key': key,
            }, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                receipt = json.load(response)
            if not isinstance(receipt, dict) or not isinstance(receipt.get('id'), str) or not receipt['id']:
                raise ValueError('Missing Resend acceptance receipt')
            return
        except urllib.error.HTTPError as error:
            error.close()
            if attempt == 2 or error.code in (400, 401, 403, 404, 422):
                raise ValueError(f'Resend rejected the alert (HTTP {error.code})') from None
        except (OSError, ValueError):
            if attempt == 2:
                raise ValueError('Resend did not accept the alert after 3 attempts') from None
        time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true',
                        help='print the alert for a failed unit instead of sending it')
    parser.add_argument('unit')
    arguments = parser.parse_args()
    unit = arguments.unit
    if not UNIT.fullmatch(unit):
        print(f'Refusing to alert for {unit!r}: not a Screenr service', file=sys.stderr)
        return 2
    try:
        api_key = setting('RESEND_API_KEY')
        sender, recipient = setting('EMAIL_FROM'), setting('BACKUP_ALERT_TO')
        state = unit_state(unit)
        active, sub = state.get('ActiveState', ''), state.get('SubState', '')
        if (active, sub) != ('failed', 'failed'):
            print(f'{unit} is {active or "unknown"} ({sub or "unknown"}); no alert')
            return 0
        subject, text = compose(unit, state)
        if arguments.dry_run:
            print(f'Dry run; would email the owner:\nSubject: {subject}\n\n{text}')
            return 0
        send({'from': sender, 'to': [recipient], 'subject': subject, 'text': text}, api_key)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Network errors can contain credentials or response bodies. Do not log them.
        detail = str(error) if type(error) is ValueError else type(error).__name__
        print(f'Failure alert for {unit} failed: {detail}', file=sys.stderr)
        return 1
    print(f'Failure alert for {unit} accepted by Resend')
    return 0


if __name__ == '__main__':
    sys.exit(main())
