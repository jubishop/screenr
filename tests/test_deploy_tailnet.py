"""Keep the production server's tailnet address out of this public repository.

The deploy job joins the tailnet and pings the server before deploying over
SSH. Anyone can read this repository and its Actions logs, so the job takes
the address from the SCREENR_DEPLOY_HOST secret and masks it, and no tracked
file names a tailnet address (#493). Failures name only the file and line.
"""
import ipaddress
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/check.yml"
FIND_STEP = "name: Find the server's tailnet address"
JOIN_STEP = "name: Join the tailnet"
# Tailscale gives each node an address in each of these ranges.
TAILNET_IPV4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_IPV6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
# A dotted quad that is not part of a longer number or a CIDR range.
IPV4 = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?!\.?\d|/\d)")
# The IPv6 range's prefix, except where it begins the range itself.
IPV6 = re.compile(re.escape(str(TAILNET_IPV6.network_address)[:-1]) + r"(?!:/\d)", re.I)
# A documentation address (RFC 5737), and a machine name as MagicDNS allows.
HOSTS = ("192.0.2.10", "screenr-vps")


def tracked_files():
    """Every committed or new, unignored file in this checkout."""
    listing = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                             cwd=ROOT, check=True, capture_output=True).stdout
    return sorted(path for name in listing.split(b"\0") if name
                  for path in [ROOT / os.fsdecode(name)] if path.is_file())


def names_tailnet_address(line):
    if IPV6.search(line):
        return True
    for match in IPV4.finditer(line):
        try:
            if ipaddress.ip_address(match[1]) in TAILNET_IPV4:
                return True
        except ValueError:
            continue
    return False


def deploy_steps():
    """Return the deploy job's steps, keyed by their first line."""
    jobs = WORKFLOW.read_text().split("\njobs:\n")[1]
    job = re.search(r"^  deploy:\n((?:(?:    .*)?\n)*)", jobs, re.M)[1]
    return {step.split("\n", 1)[0]: step for step in re.split(r"^      - ", job, flags=re.M)[1:]}


class TrackedFileTests(unittest.TestCase):
    def test_no_tracked_file_names_a_tailnet_address(self):
        found = []
        for path in tracked_files():
            text = path.read_bytes().decode("utf-8", errors="replace")
            found += [f"{path.relative_to(ROOT)}:{number}"
                      for number, line in enumerate(text.split("\n"), 1) if names_tailnet_address(line)]
        self.assertEqual(found, [], "Name the server by a secret or a placeholder, never its tailnet address.")

    def test_the_check_finds_each_way_of_writing_an_address(self):
        # Built here, so that this file names no address.
        address, address6 = str(TAILNET_IPV4[0x2a0b07]), TAILNET_IPV6[0x2a0b07]
        for line in (f"ping: {address}", f"root@{address}", f"{address},{address}", f"({address}).",
                     f"ssh {address6}", f"[{address6.exploded.upper()}]:22"):
            with self.subTest(line=line):
                self.assertTrue(names_tailnet_address(line))
        # Ranges, other addresses, and longer or shorter dotted numbers.
        for line in (TAILNET_IPV4.with_prefixlen, TAILNET_IPV6.with_prefixlen, "192.0.2.10", f"v1.{address}",
                     f"{address}.7", address.rsplit(".", 1)[0]):
            with self.subTest(line=line):
                self.assertFalse(names_tailnet_address(line))


class FindAddressStepTests(unittest.TestCase):
    def setUp(self):
        steps = deploy_steps()
        self.assertIn(FIND_STEP, list(steps))
        self.find, self.join = steps[FIND_STEP], steps[JOIN_STEP]
        self.script = textwrap.dedent(self.find.split("        run: |\n", 1)[1])

    def find_address(self, host):
        """Run the step with no shell set, as GitHub runs it, and return its
        result and the outputs it wrote."""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            output.touch()
            environment = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(output),
                           "SCREENR_DEPLOY_HOST": host}
            # GitHub runs a step that sets no shell with bash -e.
            result = subprocess.run(["bash", "-e", "-c", self.script], cwd=ROOT, env=environment,
                                    capture_output=True, text=True, timeout=10)
            return result, output.read_text()

    def test_join_pings_the_address_in_the_deploy_host_secret(self):
        step = re.search(r"^        id: (\S+)$", self.find, re.M)[1]
        self.assertIn("          SCREENR_DEPLOY_HOST: ${{ secrets.SCREENR_DEPLOY_HOST }}\n", self.find)
        self.assertEqual(re.findall(r"^          ping: (.*)$", self.join, re.M),
                         [f"${{{{ steps.{step}.outputs.address }}}}"])
        for host in HOSTS:
            with self.subTest(host=host):
                result, output = self.find_address(f"root@{host}")
                self.assertEqual(result.returncode, 0, result.stderr)
                # The log masks only the whole secret, so the step masks the address.
                self.assertEqual(result.stdout, f"::add-mask::{host}\n")
                self.assertEqual(output, f"address={host}\n")

    def test_rejects_any_other_deploy_host_without_printing_it(self):
        # The step accepts only what bin/deploy-ci accepts as the root SSH destination.
        for host in ("", "root@", "192.0.2.10", "deploy@192.0.2.10", "root@-x", "root@192.0.2.10:22",
                     "root@192.0.2.10 x", "root@192.0.2.10\naddress=192.0.2.11"):
            with self.subTest(host=host):
                result, output = self.find_address(host)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")
                self.assertIn("Set SCREENR_DEPLOY_HOST to root@", result.stdout)
                self.assertNotRegex(result.stdout + result.stderr, r"192\.0\.2\.|-x")


if __name__ == "__main__":
    unittest.main()
