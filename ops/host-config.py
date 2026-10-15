#!/usr/bin/env python3
"""Install changed Screenr systemd units and stop on shared configuration drift.

Deployment runs this as root under the deploy lock, before activation, from
the deploy kit that bin/install-deploy-kit installed from Git. The kit
directory holds the checked copies of the units, ops/Caddyfile, and
ops/postgresql.conf. This installs changed Screenr units from it and reloads
systemd. It never changes the shared Caddyfile or the PostgreSQL settings: a
difference fails the deployment before any unit is installed. Output names
files, sites, and settings, never host values, because the deployment log is
public.
"""
import os
from pathlib import Path
import re
import subprocess
import sys

UNIT = re.compile(r'screenr-[A-Za-z0-9@_.-]+\.(service|timer)')
SHARED = ('Caddyfile', 'postgresql.conf')
# A PostgreSQL setting line: name, optional '=', and a quoted or bare value.
SETTING = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=?\s*('(?:[^']|'')*'|[^\s#']+)\s*(#.*)?")


def caddy_sites(text):
    """Map each top-level site address to its lines, ignoring comments, blank lines, and indentation."""
    sites, depth, address = {}, 0, None
    for line in (raw.strip() for raw in text.splitlines()):
        if not line or line.startswith('#'):
            continue
        tokens = line.split()
        if depth == 0:
            address = ' '.join(tokens[:-1]) if len(tokens) > 1 and tokens[-1] == '{' else None
            if address:
                sites[address] = []
        elif address:
            sites[address].append(line)
        depth += tokens.count('{') - tokens.count('}')
    return sites


def postgresql_settings(text, strict):
    """Return the value PostgreSQL applies for each setting: the last one in the file."""
    settings = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.strip().startswith('#'):
            continue
        match = SETTING.fullmatch(line)
        if not match:
            if strict:
                raise ValueError(f'Unreadable line {number} in ops/postgresql.conf.')
            continue
        value = match[2]
        if value.startswith("'"):
            value = value[1:-1].replace("''", "'")
        settings[match[1].lower()] = value
    return settings


def drift(files, caddyfile, postgresql):
    """Describe each shared file that differs from the release."""
    problems = []
    host_sites = caddy_sites(caddyfile.read_text())
    sites = [address for address, lines in caddy_sites(files['Caddyfile']).items()
             if host_sites.get(address) != lines]
    if sites:
        problems.append(
            f"{caddyfile} does not match ops/Caddyfile for: {', '.join(sites)}. Deployment never changes the "
            f"shared Caddyfile. Copy these sites from ops/Caddyfile at this revision into {caddyfile}, keeping "
            f"every other site, then run caddy validate --config {caddyfile} and systemctl reload caddy, and "
            "rerun the deployment.")
    host = postgresql_settings(postgresql.read_text(), strict=False)
    settings = sorted(name for name, value in postgresql_settings(files['postgresql.conf'], strict=True).items()
                      if host.get(name) != value)
    if settings:
        problems.append(
            f"{postgresql} does not match ops/postgresql.conf for: {', '.join(settings)}. Deployment never "
            "changes PostgreSQL settings. Update the Screenr settings at the end of that file to match "
            "ops/postgresql.conf at this revision, apply them with systemctl restart screenr-db, and rerun "
            "the deployment.")
    return problems


def install_units(units, directory):
    """Install changed and new units, then reload systemd and start new timers."""
    installed, timers = [], []
    for name, content in sorted(units.items()):
        target = directory / name
        if target.is_symlink():
            # A masked or linked unit was set up by hand; leave it alone.
            print(f'{name} is a link on the host; left unchanged.', flush=True)
            continue
        data = content.encode()
        current = target.read_bytes() if target.exists() else None
        if current == data:
            continue
        temporary = directory / f'.{name}.deploying'
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        os.replace(temporary, target)
        installed.append(name)
        if current is None and name.endswith('.timer'):
            timers.append(name)
    extra = sorted(path.name for path in directory.iterdir()
                   if UNIT.fullmatch(path.name) and path.name not in units)
    if extra:
        print(f"Not in the release, left installed: {', '.join(extra)}. "
              'Disable and remove obsolete units by hand.', flush=True)
    if not installed:
        print('Screenr systemd units match the release.', flush=True)
        return
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    print(f"Installed {', '.join(installed)} from the release and reloaded systemd. "
          'Running services keep their old settings until they restart.', flush=True)
    for timer in timers:
        subprocess.run(['systemctl', 'enable', '--now', timer], check=True)
        print(f'Enabled the new timer {timer}.', flush=True)


def main():
    if len(sys.argv) != 5:
        raise ValueError('Usage: host-config.py DEPLOY_KIT UNIT_DIRECTORY CADDYFILE POSTGRESQL_CONF')
    kit = Path(sys.argv[1])
    # The kit's scripts sit beside these files; only units and shared files are read.
    files = {path.name: path.read_text() for path in kit.iterdir()
             if path.is_file() and (path.name in SHARED or UNIT.fullmatch(path.name))}
    missing = [name for name in SHARED if name not in files]
    if missing:
        raise ValueError(f"The deploy kit lacks {', '.join(missing)}. Reinstall it with bin/install-deploy-kit.")
    units = {name: content for name, content in files.items() if UNIT.fullmatch(name)}
    if not units:
        raise ValueError('The deploy kit has no Screenr units. Reinstall it with bin/install-deploy-kit.')
    problems = drift(files, Path(sys.argv[3]), Path(sys.argv[4]))
    if problems:
        for problem in problems:
            print(f'HOST CONFIGURATION DRIFT: {problem}', file=sys.stderr)
        sys.exit(1)
    print('Shared Caddy sites and PostgreSQL settings match the release.', flush=True)
    install_units(units, Path(sys.argv[2]))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Host configuration failed: {error}', file=sys.stderr)
        sys.exit(1)
