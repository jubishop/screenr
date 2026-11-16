#!/usr/bin/env python3
"""Install PostgreSQL APT repository updates for Screenr once they have waited seven days.

Unattended upgrades skip the PostgreSQL APT repository, so screenr-postgresql-updates.timer runs
this daily as root. It reads the package lists that apt-daily refreshes and remembers when it
first saw each pending version. Once one has waited SOAK_DAYS, it takes the deploy lock, backs
up, and upgrades every pending PostgreSQL repository package. When the server package changed,
it restarts screenr-db, which restarts the web and worker, checks the new server version, and
reindexes the database, the extra step that release notes most often ask for. It requires
Screenr to be healthy after every upgrade, as activation does after a deployment.

status.json records each run. .github/workflows/postgresql-updates.yml reads it through the
deploy key's postgresql-status command and opens an issue for a blocked or stalled updater:

    current   Nothing is due; any pending version is still waiting.
    updated   This run installed an update.
    retrying  An update could not be checked or installed, and Screenr was not touched.
              The next run tries again.
    blocked   The updater has been retrying for BLOCKED_DAYS, or an upgrade went wrong
              while Screenr stayed healthy.
    failed    Screenr was unhealthy after an upgrade began. The run fails, so its failure
              alert emails the owner.
"""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

SOAK_DAYS = 7
BLOCKED_DAYS = 3
SERVER_PACKAGE = 'postgresql-18'
DEPLOY_LOCK = Path('/opt/screenr/deploy.lock')
# Deployments take minutes, so a lock held longer waits for the next run.
LOCK_WAIT_SECONDS = 30 * 60
LOCK_POLL_SECONDS = 15
UNITS = ('screenr-db.service', 'screenr-web.service', 'screenr-worker.service')
LOCAL_API = 'http://127.0.0.1:3060/api/'
# Activation's limits: health within 20 attempts, then 15 seconds without a restart.
HEALTH_ATTEMPTS = 20
STABLE_SECONDS = 15
ENVIRONMENT = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
UPGRADABLE = ('apt', '-o', 'Apt::Cmd::Disable-Script-Warning=true', 'list', '--upgradable')
# Wait for unattended upgrades or apt-daily to release the dpkg lock.
APT = ('apt-get', '-q', '-o', 'DPkg::Lock::Timeout=600')
PSQL = ('runuser', '-u', 'screenr-db', '--', '/usr/lib/postgresql/18/bin/psql', '-h', '/run/screenr-db',
        '-p', '5439', '-d', 'screenr', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c')
LINE = re.compile(r'(?P<package>[a-z0-9][a-z0-9+.-]*)/(?P<suites>\S+) (?P<candidate>\S+) \S+ '
                  r'\[upgradable from: (?P<installed>[^\]\s]+)\]')


class Retry(Exception):
    """A due update could not be checked or installed, and nothing was changed."""


class Blocked(Exception):
    """An upgrade went wrong, but Screenr stayed healthy."""


class Broken(Exception):
    """Screenr was unhealthy after an upgrade began."""


def run(command, timeout, **environment):
    """Run a command with its output in the journal; return the output or raise CalledProcessError."""
    result = subprocess.run(command, env={**ENVIRONMENT, **environment}, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    if result.stdout:
        print(result.stdout, end='' if result.stdout.endswith('\n') else '\n', flush=True)
    if result.returncode:
        raise subprocess.CalledProcessError(result.returncode, command, result.stdout)
    return result.stdout


def describe(error):
    """Summarize a failed step for status.json, which a public GitHub issue may quote.

    Only apt's output is quoted: psql's errors can include table data, such as a duplicated key.
    The journal keeps every command's full output.
    """
    if isinstance(error, subprocess.CalledProcessError):
        lines = [line.strip() for line in (error.output or '').splitlines() if line.strip()]
        detail = f': {lines[-1][:200]}' if lines and error.cmd[0] in ('apt', 'apt-get') else ''
        return f'{error.cmd[0]} exited with status {error.returncode}{detail}'
    if isinstance(error, subprocess.TimeoutExpired):
        return f'{error.cmd[0]} ran past {error.timeout:g} seconds'
    return str(error) or type(error).__name__


def sentence(text):
    return text if text.endswith('.') else text + '.'


def pending_updates():
    """Return {package: (installed, candidate)} for upgradable PostgreSQL repository packages."""
    output = subprocess.run(UPGRADABLE, check=True, stdout=subprocess.PIPE, text=True, timeout=300,
                            env=ENVIRONMENT, stdin=subprocess.DEVNULL).stdout
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
    """Return the previous run's status, or an empty one when there is none or it is unreadable."""
    try:
        status = json.loads(path.read_text())
        for entry in status['pending'].values():
            datetime.date.fromisoformat(entry['since'])
        if status['trouble_since'] is not None:
            datetime.date.fromisoformat(status['trouble_since'])
        if status['last_success'] is not None:
            datetime.datetime.fromisoformat(status['last_success'])
        return status
    except FileNotFoundError:
        return {'pending': {}, 'trouble_since': None, 'last_success': None}
    except (AttributeError, KeyError, TypeError, ValueError):
        # Starting over only restarts the waits; refusing would stop every update.
        print(f'Ignoring unreadable saved status in {path}', file=sys.stderr, flush=True)
        return {'pending': {}, 'trouble_since': None, 'last_success': None}


def save(path, status):
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.status-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(status, output, indent=2, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        # The deploy key's postgresql-status command reads it as root; nothing in it is secret.
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextlib.contextmanager
def deploy_lock():
    """Hold the deploy lock, so no deployment, release cleanup, or restore runs meanwhile."""
    with DEPLOY_LOCK.open('a') as lock:
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Retry(f'A deployment, release cleanup, or restore held {DEPLOY_LOCK} for '
                                f'{LOCK_WAIT_SECONDS // 60} minutes.') from None
                time.sleep(LOCK_POLL_SECONDS)
        yield


def local_get(path):
    with urllib.request.urlopen(LOCAL_API + path, timeout=2) as response:
        return response.read().decode()


def service_state():
    return run(('systemctl', 'show', *UNITS[1:], '-p', 'Id', '-p', 'ActiveState', '-p', 'NRestarts',
                '-p', 'ActiveEnterTimestampMonotonic'), timeout=30)


def healthy():
    """Apply activation's health check: the API answers, Better Auth reads the database, and the units run."""
    try:
        local_get('health')
        if local_get('auth/get-session').strip() != 'null':
            return False
        run(('systemctl', 'is-active', '--quiet', *UNITS), timeout=30)
        return True
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def wait_until_healthy():
    """Wait for health, then require the web and worker to stay up without restarting."""
    for _ in range(HEALTH_ATTEMPTS):
        if healthy():
            before = service_state()
            time.sleep(STABLE_SECONDS)
            if healthy() and service_state() == before:
                return
            raise ValueError(f'A Screenr service stopped or restarted within {STABLE_SECONDS} seconds of '
                             'starting.')
        time.sleep(1)
    raise ValueError(f'Screenr did not pass its health checks within {HEALTH_ATTEMPTS} attempts.')


def upgrade(updates):
    """Upgrade every pending PostgreSQL repository package under the deploy lock, after a backup."""
    packages = sorted(updates)
    try:
        plan = run((*APT, '--simulate', 'install', '--only-upgrade', *packages), timeout=300)
    except subprocess.SubprocessError as error:
        raise Retry(f'Could not plan the upgrade: {describe(error)}') from None
    removals = sorted(line.split()[1] for line in plan.splitlines() if line.startswith('Remv '))
    if removals:
        raise Retry(f'Upgrading would remove {", ".join(removals)}, so it needs a person.')
    with deploy_lock():
        try:
            run((*APT, '--yes', '--download-only', 'install', '--only-upgrade', *packages), timeout=900)
            # A failed backup sends its own alert.
            run(('systemctl', 'start', 'screenr-backup.service'), timeout=1200)
        except subprocess.SubprocessError as error:
            raise Retry(f'Could not prepare the upgrade: {describe(error)}') from None
        step = 'install the packages'
        try:
            run((*APT, '--yes', '-o', 'Dpkg::Options::=--force-confold', 'install', '--only-upgrade',
                 *packages), timeout=1800, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
            if SERVER_PACKAGE in updates:
                # PostgreSQL's package scripts restart only clusters that postgresql-common manages.
                step = 'restart screenr-db'
                run(('systemctl', 'restart', 'screenr-db.service'), timeout=600)
            step = 'confirm that Screenr is healthy'
            wait_until_healthy()
            if SERVER_PACKAGE in updates:
                step = 'confirm the new server version'
                expected = updates[SERVER_PACKAGE][1].split('-')[0]
                version = run((*PSQL, 'SHOW server_version'), timeout=60).strip()
                if version.split()[:1] != [expected]:
                    raise ValueError(f'PostgreSQL reports version {version[:60]!r}, not {expected}.')
                step = 'reindex the database'
                run((*PSQL, 'REINDEX DATABASE screenr'), timeout=900)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            detail = sentence(f'Could not {step}: {describe(error)}')
            try:
                wait_until_healthy()
            except (OSError, ValueError, subprocess.SubprocessError) as health:
                raise Broken(sentence(f'{detail} Screenr is unhealthy: {describe(health)}')) from None
            raise Blocked(f'{detail} Screenr is still healthy.') from None


def listing(status, packages):
    return ', '.join(f'{package} {entry["installed"]} -> {key.split(" ", 1)[1]}'
                     for key, entry in sorted(status['pending'].items())
                     for package in [key.split(' ', 1)[0]] if package in packages)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true',
                        help='report pending and due updates without installing or saving anything')
    arguments = parser.parse_args()
    path = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/screenr-postgresql-updates')) / 'status.json'
    now = datetime.datetime.fromtimestamp(time.time(), datetime.timezone.utc)
    today = now.date()
    previous = load(path)
    status = {'checked': now.isoformat(timespec='seconds'), 'last_success': previous['last_success'],
              'trouble_since': None, 'pending': {}}
    try:
        try:
            updates = pending_updates()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise Retry(f'Could not list pending updates: {describe(error)}') from None
        for package, (installed, candidate) in sorted(updates.items()):
            key = f'{package} {candidate}'
            since = previous['pending'].get(key, {}).get('since', today.isoformat())
            status['pending'][key] = {'installed': installed, 'since': since}
            print(f'Pending PostgreSQL update: {package} {installed} -> {candidate}, first seen {since}', flush=True)
        oldest = min((datetime.date.fromisoformat(entry['since']) for entry in status['pending'].values()),
                     default=None)
        if oldest is None or (today - oldest).days < SOAK_DAYS:
            due = oldest and oldest + datetime.timedelta(days=SOAK_DAYS)
            status['result'] = 'current'
            status['message'] = (f'Waiting until {due} to install {listing(status, updates)}.' if due
                                 else 'No PostgreSQL updates pending.')
        elif arguments.dry_run:
            print(f'Dry run; would install {listing(status, updates)}', flush=True)
            return 0
        else:
            upgrade(updates)
            status['result'] = 'updated'
            status['message'] = f'Installed {listing(status, updates)}.'
            status['pending'] = {}
        status['last_success'] = status['checked']
    except Retry as error:
        since = datetime.date.fromisoformat(previous['trouble_since'] or today.isoformat())
        status['trouble_since'] = since.isoformat()
        status['result'] = 'blocked' if (today - since).days >= BLOCKED_DAYS else 'retrying'
        status['message'] = f'{sentence(str(error))} Retrying daily since {since}.'
    except Blocked as error:
        status['trouble_since'] = previous['trouble_since'] or today.isoformat()
        status['result'], status['message'] = 'blocked', str(error)
    except Broken as error:
        status['trouble_since'] = previous['trouble_since'] or today.isoformat()
        status['result'], status['message'] = 'failed', str(error)
    print(f'PostgreSQL update {status["result"]}: {status["message"]}', flush=True)
    if not arguments.dry_run:
        save(path, status)
    return 1 if status['result'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
