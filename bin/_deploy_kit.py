"""The deploy kit: the checked ops/ files that root runs or compares during deployment.

bin/install-deploy-kit installs the kit on the host from a Git revision.
bin/deploy-ci computes the same digest from the revision it deploys, and
ops/receive-release refuses to deploy when the installed kit differs.
"""
import hashlib
import io
from pathlib import PurePosixPath
import re
import tarfile

# The receiver is installed at /usr/local/sbin/screenr-receive-release; the
# other files go to /usr/local/lib/screenr-deploy.
RECEIVER = 'receive-release'
SCRIPTS = (RECEIVER, 'deploy-release.sh', 'activate.sh', 'host-config.py', 'prune-releases.py')
# Deployment compares these with the shared host configuration but never installs them.
SHARED = ('Caddyfile', 'postgresql.conf')
UNIT = re.compile(r'screenr-[A-Za-z0-9@_.-]+\.(service|timer)')


def kit_digest(files):
    """Digest {name: bytes} the way ops/receive-release digests the installed kit."""
    listing = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in sorted(files.items()))
    return hashlib.sha256(listing.encode()).hexdigest()


def checked_kit(ops_tar):
    """Return the kit's files from a `git archive --format=tar REVISION ops/` stream."""
    files = {}
    with tarfile.open(fileobj=io.BytesIO(ops_tar)) as tree:
        for member in tree.getmembers():
            path = PurePosixPath(member.name)
            if member.isfile() and path.parent == PurePosixPath('ops') and (
                    path.name in SCRIPTS + SHARED or UNIT.fullmatch(path.name)):
                files[path.name] = tree.extractfile(member).read()
    missing = [f'ops/{name}' for name in SCRIPTS + SHARED if name not in files]
    if missing:
        raise ValueError(f"Missing checked deploy kit files: {', '.join(missing)}")
    if not any(UNIT.fullmatch(name) for name in files):
        raise ValueError('Missing checked deploy kit files: the revision defines no Screenr units.')
    return files
