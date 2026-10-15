"""Exercise the deploy kit installer with fake Git and SSH boundaries.

The fake host unpacks what the installer sends and answers with the digest
that ops/receive-release computes for it, so the installer, bin/deploy-ci,
and the receiver must agree on the kit's files and digest.
"""
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REVISION = 'a' * 40

FAKE_COMMAND = r'''#!/usr/bin/env python3
import hashlib, io, json, os, sys, tarfile
from pathlib import Path
name, args = Path(sys.argv[0]).name, sys.argv[1:]
base = Path(os.environ['FIXTURE'])
with (base / 'calls').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
if name == 'git':
    if args[:2] == ['rev-parse', '--verify']:
        if args[2] not in ('HEAD^{commit}', 'a' * 40 + '^{commit}'): sys.exit(128)
        print('a' * 40)
    elif args == ['archive', '--format=tar', 'a' * 40, 'ops/']:
        with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as tree:
            for path in sorted((base / 'checked/ops').iterdir()):
                tree.add(path, arcname='ops/' + path.name)
    else: sys.exit(99)
elif name == 'ssh':
    if os.environ.get('SSH_EXIT'): sys.exit(int(os.environ['SSH_EXIT']))
    host = base / 'host'
    host.mkdir()
    with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())) as sent:
        sent.extractall(host, filter='data')
    # The receiver digests itself and the other kit files, as installed.
    files = {path.name: path.read_bytes() for path in host.iterdir()}
    listing = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(files.items()))
    digest = os.environ.get('HOST_KIT') or hashlib.sha256(listing.encode()).hexdigest()
    print('Installed.')
    print(json.dumps(dict(active='0' * 40, kit=digest)))
'''


class InstallDeployKitTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        (self.base / 'bin').mkdir()
        for name in ('install-deploy-kit', '_deploy_kit.py'):
            shutil.copy2(ROOT / 'bin' / name, self.base / 'bin' / name)
        (self.base / 'checked/ops').mkdir(parents=True)
        for path in (ROOT / 'ops').iterdir():
            if path.is_file():
                shutil.copy2(path, self.base / 'checked/ops' / path.name)
        commands = self.base / 'commands'
        commands.mkdir()
        (commands / 'command').write_text(FAKE_COMMAND)
        (commands / 'command').chmod(0o755)
        for name in ('git', 'ssh'):
            (commands / name).symlink_to(commands / 'command')
        self.environment = {**os.environ, 'FIXTURE': str(self.base),
                            'PATH': str(commands) + os.pathsep + os.environ['PATH']}

    def execute(self, *args, **environment):
        return subprocess.run([str(self.base / 'bin/install-deploy-kit'), *args], cwd=self.base,
                              env={**self.environment, **environment}, text=True,
                              capture_output=True, timeout=15)

    def calls(self):
        path = self.base / 'calls'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_installs_exactly_the_kit_from_git(self):
        (self.base / 'ops').mkdir()
        (self.base / 'ops/activate.sh').write_text('echo unchecked working copy\n')
        result = self.execute('root@example.test', 'HEAD')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed deploy kit', result.stdout)
        self.assertIn(REVISION, result.stdout)
        installed = {path.name: path.read_bytes() for path in (self.base / 'host').iterdir()}
        checked = self.base / 'checked/ops'
        expected = {path.name: path.read_bytes() for path in checked.iterdir()
                    if path.name in ('receive-release', 'deploy-release.sh', 'activate.sh', 'host-config.py',
                                     'prune-releases.py', 'Caddyfile', 'postgresql.conf')
                    or (path.name.startswith('screenr-') and path.suffix in ('.service', '.timer'))}
        self.assertEqual(installed, expected)
        for name in ('backup.sh', 'provision.sh', 'backup.env.example'):
            self.assertNotIn(name, installed)
        ssh = [call for call in self.calls() if call[0] == 'ssh']
        self.assertEqual(len(ssh), 1)
        self.assertIn('root@example.test', ssh[0])
        self.assertIn('BatchMode=yes', ssh[0])

    def test_host_reporting_another_kit_fails(self):
        result = self.execute('root@example.test', REVISION, HOST_KIT='c' * 64)
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not match', result.stderr)
        self.assertNotIn('Installed deploy kit', result.stdout)

    def test_failed_installation_fails(self):
        result = self.execute('root@example.test', REVISION, SSH_EXIT='1')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Installed deploy kit', result.stdout)

    def test_bad_arguments_never_contact_the_host(self):
        for args in ((), ('root@example.test',), ('example.test', REVISION), ('root@-oProxyCommand=x', REVISION),
                     ('root@example.test', 'unknown-revision'), ('root@example.test', REVISION, 'extra')):
            with self.subTest(args=args):
                (self.base / 'calls').unlink(missing_ok=True)
                result = self.execute(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[0] == 'ssh' for call in self.calls()))

    def test_incomplete_kit_never_contacts_the_host(self):
        (self.base / 'checked/ops/host-config.py').unlink()
        result = self.execute('root@example.test', REVISION)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ops/host-config.py', result.stderr)
        self.assertFalse(any(call[0] == 'ssh' for call in self.calls()))

    def test_remote_installation_script_passes_shellcheck(self):
        if not shutil.which('shellcheck'):
            self.skipTest('ShellCheck is not installed.')
        sys.path.insert(0, str(ROOT / 'bin'))
        loader = SourceFileLoader('install_deploy_kit', str(ROOT / 'bin/install-deploy-kit'))
        spec = spec_from_loader('install_deploy_kit', loader)
        assert spec
        module = module_from_spec(spec)
        loader.exec_module(module)
        result = subprocess.run(['shellcheck', '--shell=sh', '-'], input=module.INSTALL, text=True,
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == '__main__':
    unittest.main()
