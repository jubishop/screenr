"""Check the systemd sandbox of the web and worker units.

Deployment installs these units and activation restarts both services under
them, with no automatic return to the previous units. A setting that stops
either service therefore takes production down, so these tests keep what the
services need open: loopback PostgreSQL, HTTPS to Resend and TMDB, the Node
runtime, the release, and the web's Next cache.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
APPS = ('screenr-web.service', 'screenr-worker.service')
# The decided sandbox for both units (#118).
DECIDED = {
    'NoNewPrivileges': 'true',
    'PrivateTmp': 'true',
    'PrivateDevices': 'true',
    'ProtectSystem': 'strict',
    'ProtectHome': 'true',
    'ProtectKernelTunables': 'true',
    'ProtectKernelModules': 'true',
    'ProtectKernelLogs': 'true',
    'ProtectControlGroups': 'true',
    'ProtectClock': 'true',
    'ProtectHostname': 'true',
    'ProtectProc': 'invisible',
    'ProcSubset': 'pid',
    'RestrictNamespaces': 'true',
    'RestrictSUIDSGID': 'true',
    'LockPersonality': 'true',
    'SystemCallFilter': '@system-service',
    'SystemCallArchitectures': 'native',
    'CapabilityBoundingSet': '',
}
# Paths the services read at run time.
NEEDED = ('/opt/screenr', '/opt/node', '/etc/screenr', '/usr', '/etc/ssl', '/etc/resolv.conf')
# Other applications' directories on the shared host.
OTHER_APPLICATIONS = ('/opt/health', '/opt/kidsbank', '/opt/news', '/opt/trading', '/etc/caddy')


def service(name):
    """Parse a unit's [Service] section into {key: [values]}."""
    settings, section = {}, None
    for line in (ROOT / 'ops' / name).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            section = line
        elif section == '[Service]':
            key, value = line.split('=', 1)
            settings.setdefault(key, []).append(value)
    return settings


def words(settings, key):
    return ' '.join(settings.get(key, [])).split()


class AppSandboxTests(unittest.TestCase):
    def test_web_and_worker_apply_the_decided_sandbox(self):
        for name in APPS:
            settings = service(name)
            for key, value in DECIDED.items():
                with self.subTest(unit=name, setting=key):
                    self.assertEqual(settings.get(key), [value])

    def test_web_and_worker_share_one_sandbox(self):
        # Only the web writes files: Next's image and fetch cache.
        web, worker = service('screenr-web.service'), service('screenr-worker.service')
        self.assertEqual(web.pop('ReadWritePaths'), ['/opt/screenr/current/.next/cache'])
        self.assertNotIn('ReadWritePaths', worker)
        sandbox = set(DECIDED) | {'RestrictAddressFamilies', 'RestrictRealtime', 'SystemCallErrorNumber',
                                  'InaccessiblePaths', 'UMask'}
        self.assertEqual({key: web[key] for key in sandbox}, {key: worker.get(key) for key in sandbox})

    def test_sandbox_keeps_network_access_the_services_need(self):
        for name in APPS:
            with self.subTest(unit=name):
                settings = service(name)
                # PostgreSQL listens on 127.0.0.1:5439; Resend and TMDB need
                # outbound HTTPS. A private network would cut off both.
                self.assertEqual(sorted(words(settings, 'RestrictAddressFamilies')),
                                 ['AF_INET', 'AF_INET6', 'AF_UNIX'])
                for key in ('PrivateNetwork', 'IPAddressDeny', 'IPAddressAllow', 'RestrictNetworkInterfaces'):
                    self.assertNotIn(key, settings)
        # Without HOSTNAME, Next lists the network interfaces at startup, which
        # needs the netlink sockets that the sandbox refuses.
        self.assertIn('HOSTNAME=127.0.0.1', service('screenr-web.service')['Environment'])

    def test_sandbox_keeps_the_runtime_working(self):
        for name in APPS:
            with self.subTest(unit=name):
                settings = service(name)
                # V8's JIT writes executable memory.
                self.assertNotIn('MemoryDenyWriteExecute', settings)
                # A syscall outside the filter fails with EPERM instead of
                # killing the service.
                self.assertEqual(settings.get('SystemCallErrorNumber'), ['EPERM'])
                self.assertEqual(settings['User'], ['screenr'])
                self.assertTrue(settings['ExecStart'][0].startswith('/opt/screenr/node/bin/node '))
                for key in ('PrivateUsers', 'DynamicUser', 'TemporaryFileSystem', 'ReadOnlyPaths'):
                    self.assertNotIn(key, settings)

    def test_other_applications_are_hidden_and_screenr_paths_are_not(self):
        for name in APPS:
            with self.subTest(unit=name):
                hidden = words(service(name), 'InaccessiblePaths')
                # A missing path would fail the unit; '-' ignores it.
                self.assertTrue(hidden and all(path.startswith('-/') for path in hidden), hidden)
                paths = [path[1:] for path in hidden]
                for path in OTHER_APPLICATIONS:
                    self.assertIn(path, paths)
                for path in paths:
                    for needed in NEEDED:
                        self.assertFalse(needed == path or needed.startswith(path + '/')
                                         or path.startswith(needed + '/'), (path, needed))


if __name__ == '__main__':
    unittest.main()
