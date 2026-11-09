#!/usr/bin/env python3
"""Read the screenr-web and screenr-worker journal for one time window over SSH, read-only.

Usage:
  fetch_server_journal.py --host USER@HOST --since TIME --until TIME --out FILE
                          [--request-id ID]

TIME is UTC, such as 2026-11-08T20:14:48Z. The window's lines go to FILE,
which must not exist yet; keep it outside the repository, since failure lines
can carry member IDs. The summary counts the window's failure lines by event,
and those for --request-id, and says when the window starts before the oldest
line the journal still keeps. It never prints a journal line.
See docs/deployment.md#failure-logs for the lines.
"""

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import sys

UNITS = ("screenr-web", "screenr-worker")
HOST = re.compile(r"(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*")
TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", re.ASCII)
# The server accepts a client's Screenr-Request-Id only in this form.
REQUEST_ID = re.compile(r"[\w-]{1,64}", re.ASCII)
SEPARATOR = "--- window ---"


def utc(value):
    if not TIME.fullmatch(value):
        raise argparse.ArgumentTypeError("expected a UTC time such as 2026-11-08T20:14:48Z")
    return value


def matching(pattern, description):
    def check(value):
        if not pattern.fullmatch(value):
            raise argparse.ArgumentTypeError(f"expected {description}")
        return value
    return check


def arguments():
    parser = argparse.ArgumentParser(prog="fetch_server_journal.py", description=__doc__.splitlines()[0])
    parser.add_argument("--host", required=True, type=matching(HOST, "USER@HOST"))
    parser.add_argument("--since", required=True, type=utc)
    parser.add_argument("--until", required=True, type=utc)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--request-id", type=matching(REQUEST_ID, "a request ID of letters, digits, _, and -"))
    args = parser.parse_args()
    if args.since >= args.until:
        parser.error("--since must come before --until")
    if args.out.exists() or args.out.is_symlink():
        parser.error(f"output file must not already exist; choose a fresh path: {args.out}")
    return args


def remote_command(since, until):
    """Print the oldest kept line, a separator, then the window; every value is validated above."""
    units = " ".join(f"-u {unit}" for unit in UNITS)
    journal = f"journalctl {units} --no-pager -q -o short-iso-precise"
    return (f"{journal} | head -n 1; echo '{SEPARATOR}'; "
            f"{journal} --since {since} --until {until}")


def failure(line):
    """Return a journal line's failure fields, or None for any other line."""
    start = line.find("{")
    if start < 0:
        return None
    try:
        fields = json.loads(line[start:])
    except ValueError:
        return None
    return fields if isinstance(fields, dict) and isinstance(fields.get("event"), str) else None


def main():
    args = arguments()
    try:
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", args.host,
             remote_command(args.since, args.until)],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        print("Error: the journal read over SSH took more than 5 minutes.", file=sys.stderr)
        return 1
    if result.returncode != 0:
        print(f"Error: the journal read over SSH failed with exit status {result.returncode}.", file=sys.stderr)
        if result.stderr:
            print(result.stderr.rstrip()[-2000:], file=sys.stderr)
        return 1
    head, separator, window = result.stdout.partition(SEPARATOR + "\n")
    if not separator:
        print("Error: the host's reply had no window separator.", file=sys.stderr)
        return 1
    oldest = head.split(" ", 1)[0].strip()
    try:
        kept_from = datetime.fromisoformat(oldest) if oldest else None
    except ValueError:
        print("Error: the host's oldest journal line has no readable time.", file=sys.stderr)
        return 1
    lines = window.splitlines()
    args.out.write_text(window)

    failures = [fields for fields in map(failure, lines) if fields is not None]
    print(f"Journal of {' and '.join(UNITS)}")
    print(f"  Window: {args.since} to {args.until}")
    print(f"  Oldest kept line: {oldest or 'none; the journal has no lines for these units'}")
    if kept_from is None or kept_from > datetime.fromisoformat(args.since):
        print("  The window starts before the oldest kept line, so its earlier lines are gone.")
    print(f"  Lines in window: {len(lines)}; failure lines: {len(failures)}")
    for event, count in sorted(Counter(fields["event"] for fields in failures).items()):
        print(f"    {event}: {count}")
    if args.request_id:
        matches = [fields for fields in failures if fields.get("requestId") == args.request_id]
        print(f"  Failure lines for request {args.request_id}: {len(matches)}")
        for event, count in sorted(Counter(fields["event"] for fields in matches).items()):
            print(f"    {event}: {count}")
    print(f"  Output: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
