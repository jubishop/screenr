#!/usr/bin/env python3
"""Measure the dedicated R2 backup bucket and send one warning above 1 GB."""
import datetime
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

THRESHOLD = 1_000_000_000
# Leave room for request duration and clock differences within Resend's 24 hours.
RETRY_WINDOW = 23 * 3600


def failure_alert():
    """Load the settings and Resend delivery of failure-alert.py from the same release."""
    spec = importlib.util.spec_from_file_location(
        'failure_alert', Path(__file__).resolve().with_name('failure-alert.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bucket_url(setting):
    repository = setting('RESTIC_REPOSITORY')
    if not repository.startswith('s3:https://'):
        raise ValueError('Backup size monitoring requires an HTTPS R2 repository')
    url = urllib.parse.urlsplit(repository[3:])
    bucket = url.path.strip('/').split('/')[0]
    if (not url.hostname or not url.hostname.endswith('.r2.cloudflarestorage.com')
            or url.username or url.password or url.port or url.query or url.fragment or not bucket):
        raise ValueError('Invalid R2 backup repository URL')
    return urllib.parse.urlunsplit(('https', url.hostname, '/' + bucket, '', ''))


def list_bucket(url, access, secret):
    total, count = 0, 0
    token = None
    seen = set()
    parsed = urllib.parse.urlsplit(url)
    while True:
        parameters = {'list-type': '2', 'max-keys': '1000'}
        if token:
            parameters['continuation-token'] = token
        query = urllib.parse.urlencode(sorted(parameters.items()), quote_via=urllib.parse.quote)
        stamp = datetime.datetime.fromtimestamp(time.time(), datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        day = stamp[:8]
        digest = hashlib.sha256(b'').hexdigest()
        headers = {'host': parsed.netloc, 'x-amz-content-sha256': digest, 'x-amz-date': stamp}
        signed = ';'.join(headers)
        canonical = '\n'.join(('GET', parsed.path, query,
                               ''.join(f'{key}:{value}\n' for key, value in headers.items()),
                               signed, digest))
        scope = f'{day}/auto/s3/aws4_request'
        to_sign = '\n'.join(('AWS4-HMAC-SHA256', stamp, scope,
                             hashlib.sha256(canonical.encode()).hexdigest()))
        key = ('AWS4' + secret).encode()
        for part in (day, 'auto', 's3', 'aws4_request'):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
        headers['Authorization'] = (f'AWS4-HMAC-SHA256 Credential={access}/{scope}, '
                                    f'SignedHeaders={signed}, Signature={signature}')
        request = urllib.request.Request(url + '?' + query, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            root = ET.fromstring(response.read())
        if root.tag.split('}')[-1] != 'ListBucketResult':
            raise ValueError('Invalid R2 listing response')
        for item in root.findall('{*}Contents'):
            size = int(item.findtext('{*}Size', '-1'))
            if size < 0:
                raise ValueError('Invalid R2 object size')
            total += size
            count += 1
        truncated = root.findtext('{*}IsTruncated')
        if truncated == 'false':
            return total, count
        token = root.findtext('{*}NextContinuationToken')
        if truncated != 'true' or not token or token in seen:
            raise ValueError('Invalid R2 listing continuation')
        seen.add(token)


def save(path, state):
    descriptor, temporary = tempfile.mkstemp(prefix='.size-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(state, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def send_warning(alert, path, state, api_key):
    warning = state['warning']
    if warning['sent_at'] is not None:
        return
    # Whether the current attempt is the warning's first, with no earlier request whose
    # response may have been lost.
    first = False

    def before_attempt():
        nonlocal first
        now = time.time()
        previous_attempt = warning['attempted_at']
        if previous_attempt is not None and not 0 <= now - previous_attempt < RETRY_WINDOW:
            raise ValueError('Email delivery uncertain; reconcile size.json with Resend before retrying')
        first = previous_attempt is None
        if first:
            warning['attempted_at'] = now
            save(path, state)

    def on_http_error(status):
        # A definite rejection of the first attempt permits a later retry.
        # A rejection cannot resolve an earlier request with a lost response.
        if status in alert.REJECTIONS + (429,) and first:
            warning['attempted_at'] = None
            save(path, state)

    email_id = alert.deliver(warning['message'], api_key, warning['key'],
                             'Screenr-backup-monitor/1', 'the backup warning',
                             before_attempt, on_http_error)
    warning['sent_at'] = time.time()
    warning['email_id'] = email_id
    save(path, state)
    print('Backup storage warning accepted by Resend')


def main():
    if sys.version_info < (3, 10):
        raise ValueError('Python 3.10 or newer is required')
    alert = failure_alert()
    setting = alert.setting
    url = bucket_url(setting)
    access, secret = setting('AWS_ACCESS_KEY_ID'), setting('AWS_SECRET_ACCESS_KEY')
    api_key = setting('RESEND_API_KEY')
    sender, recipient = setting('EMAIL_FROM'), setting('BACKUP_ALERT_TO')
    directory = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/screenr-backup'))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / 'size.json'
    with (directory / 'size.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(path.read_text()) if path.exists() else {}
        total, count = list_bucket(url, access, secret)
        if state.get('bucket') != url:
            state = {}
        state.update(bucket=url, bytes=total, objects=count, checked_at=time.time())
        if total < THRESHOLD:
            state['warning'] = None
        elif total > THRESHOLD and not state.get('warning'):
            state['warning'] = {
                'key': 'screenr-backup-size/' + str(uuid.uuid4()),
                'attempted_at': None,
                'sent_at': None,
                'message': {
                    'from': sender, 'to': [recipient],
                    'subject': 'Screenr backup storage exceeds 1 GB',
                    'text': (f'Screenr backups use {total:,} bytes ({total / THRESHOLD:.3f} GB) '
                             f'across {count:,} objects after backup cleanup.\n\n'
                             'The warning threshold is 1 GB (1,000,000,000 bytes). '
                             'Backups continue with seven daily and four weekly snapshots. '
                             'No further warning is sent until storage falls below 1 GB '
                             'and exceeds it again.\n\n'
                             'Check Cloudflare R2 storage and account usage. This measures '
                             'the dedicated Screenr backup bucket, not other buckets or '
                             'incomplete uploads. It is not an account spending cap.'),
                },
            }
        save(path, state)
        print(f'Screenr backup storage: {total} bytes in {count} objects; threshold {THRESHOLD} bytes')
        if state.get('warning'):
            send_warning(alert, path, state, api_key)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, ET.ParseError) as error:
        # Network errors can contain credentials or response bodies. Do not log them.
        detail = str(error) if type(error) is ValueError else type(error).__name__
        print(f'Backup size check failed (completed backups are unchanged): {detail}', file=sys.stderr)
        sys.exit(1)
