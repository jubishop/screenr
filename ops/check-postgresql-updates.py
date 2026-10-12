#!/usr/bin/env python3
"""Email the owner once when a PostgreSQL repository update has been pending for three days.

Unattended upgrades skip the PostgreSQL APT repository, so its updates are installed by hand.
This reads the package lists that apt-daily refreshes and installs nothing. It remembers when
each pending version was first seen, and sends one notice through failure-alert.py's Resend
delivery when any of them has waited three days. A newer version starts its own wait.
"""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time

WAIT_DAYS = 3
UPGRADABLE = ('apt', '-o', 'Apt::Cmd::Disable-Script-Warning=true', 'list', '--upgradable')
LINE = re.compile(r'(?P<package>[a-z0-9][a-z0-9+.-]*)/(?P<suites>\S+) (?P<candidate>\S+) \S+ '
                  r'\[upgradable from: (?P<installed>[^\]\s]+)\]')
RUNBOOK = 'https://github.com/jubishop/screenr/blob/main/docs/restore-and-patching.md#postgresql'


def pending_updates():
    """Return {package: (installed, candidate)} for upgradable PostgreSQL repository packages."""
    output = subprocess.run(UPGRADABLE, check=True, stdout=subprocess.PIPE, text=True, timeout=300,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}).stdout
    updates = {}
    for line in output.splitlines():
        if line in ('', 'Listing...'):
            continue
        match = LINE.fullmatch(line)
        if not match:
            # A format change must not read as "nothing pending".
            raise ValueError(f'Unexpected apt output: {line[:120]!r}')
        if any(suite.endswith('-pgdg') for suite in match['suites'].split(',')):
            updates[match['package']] = match['installed'], match['candidate']
    return updates


def load(path):
    """Return {'<package> <candidate>': {'since': ISO date, 'notified': bool}}."""
    try:
        state = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except ValueError:
        raise ValueError(f'Invalid saved state in {path}') from None
    try:
        for entry in state.values():
            datetime.date.fromisoformat(entry['since'])
            if not isinstance(entry['notified'], bool):
                raise TypeError
    except (AttributeError, KeyError, TypeError, ValueError):
        raise ValueError(f'Invalid saved state in {path}') from None
    return state


def save(path, state):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(state, output, indent=2, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def compose(updates, state):
    lines = ''.join(f'{package}: {installed} -> {candidate} '
                    f'(first seen {state[f"{package} {candidate}"]["since"]})\n'
                    for package, (installed, candidate) in sorted(updates.items()))
    text = (f'A PostgreSQL package update from the PostgreSQL APT repository has been pending for '
            f'at least {WAIT_DAYS} days. Unattended upgrades do not install these updates.\n\n'
            f'Pending updates:\n{lines}\nHost: {socket.gethostname()}\n\n'
            'Read the release notes at https://www.postgresql.org/docs/release/ for extra steps, '
            f'then install the update by hand as the runbook describes:\n{RUNBOOK}\n'
            'It restarts the database, web application, and email worker.\n\n'
            'This notice is sent once for each new package version.')
    return 'Screenr alert: PostgreSQL update pending', text


def failure_alert():
    """Load the Resend delivery of failure-alert.py from the same release."""
    spec = importlib.util.spec_from_file_location(
        'failure_alert', Path(__file__).resolve().with_name('failure-alert.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true',
                        help='print the notice when one is due instead of sending it; save nothing')
    arguments = parser.parse_args()
    directory = os.environ.get('STATE_DIRECTORY', '/var/lib/screenr-postgresql-updates')
    path = Path(directory) / 'pending.json'
    try:
        today = datetime.datetime.fromtimestamp(time.time(), datetime.timezone.utc).date()
        updates = pending_updates()
        saved = load(path)
        state = {}
        for package, (installed, candidate) in sorted(updates.items()):
            key = f'{package} {candidate}'
            state[key] = saved.get(key) or {'since': today.isoformat(), 'notified': False}
            print(f'Pending PostgreSQL update: {package} {installed} -> {candidate}, '
                  f'first seen {state[key]["since"]}')
        if not updates:
            print('No PostgreSQL updates pending')
        due = any(not entry['notified']
                  and (today - datetime.date.fromisoformat(entry['since'])).days >= WAIT_DAYS
                  for entry in state.values())
        if not due:
            if not arguments.dry_run:
                save(path, state)
            print('No notice due')
            return 0
        subject, text = compose(updates, state)
        if arguments.dry_run:
            print(f'Dry run; would email the owner:\nSubject: {subject}\n\n{text}')
            return 0
        # Keep first-seen dates even when delivery fails; the next check retries the notice.
        save(path, state)
        alert = failure_alert()
        api_key = alert.setting('RESEND_API_KEY')
        sender, recipient = alert.setting('EMAIL_FROM'), alert.setting('BACKUP_ALERT_TO')
        alert.send({'from': sender, 'to': [recipient], 'subject': subject, 'text': text}, api_key)
        for entry in state.values():
            entry['notified'] = True
        save(path, state)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # failure-alert.py turns network errors, which can contain credentials, into ValueError.
        detail = (str(error) if isinstance(error, (ValueError, subprocess.SubprocessError))
                  else type(error).__name__)
        print(f'PostgreSQL update check failed: {detail}', file=sys.stderr)
        return 1
    print('PostgreSQL update notice accepted by Resend')
    return 0


if __name__ == '__main__':
    sys.exit(main())
