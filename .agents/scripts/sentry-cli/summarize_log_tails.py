#!/usr/bin/env python3
"""Summarize the log tails that feedback attaches, around the time the member sent it.

Usage:
  summarize_log_tails.py --at TIME [--before MINUTES] [--after MINUTES] FILE [FILE ...]

FILE is a downloaded log tail, such as app.ndjson or notifications.ndjson: one
JSON object per line with time, level, category, message, launch, and fields,
as ios/README.md#logging describes. TIME is the feedback's submission time in
UTC, such as 2026-11-09T23:50:12Z. For each file it prints its time span and
launches, marking the launch the feedback came from, when the app logged
"Sending feedback", every line from MINUTES before TIME (10 by default) to
MINUTES after it (1 by default), and that window's failed API calls with their
request IDs, which the server's journal and Sentry share. It counts unreadable
lines without printing them. The lines hold no member content, but the user
and request IDs they print must stay out of GitHub.
"""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys

TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", re.ASCII)
# Terminal control characters, which an untrusted attachment could use to rewrite the output.
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
LONGEST_VALUE = 200
SENDING = "Sending feedback"


def moment(value):
    """Parse an ISO 8601 time with a zone, or return None."""
    if not isinstance(value, str) or not TIME.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:  # Such as a 13th month.
        return None


def submission(value):
    parsed = moment(value)
    if parsed is None:
        raise argparse.ArgumentTypeError("expected a time with a zone, such as 2026-11-09T23:50:12Z")
    return parsed


def minutes(value):
    try:
        number = float(value)
    except ValueError:
        number = -1
    if not 0 <= number <= 24 * 60:
        raise argparse.ArgumentTypeError("expected minutes from 0 to 1440")
    return timedelta(minutes=number)


def text(value):
    """Show a value on one line, without control characters, and cut to a readable length."""
    shown = CONTROL.sub("?", value if isinstance(value, str) else json.dumps(value))
    return shown if len(shown) <= LONGEST_VALUE else shown[:LONGEST_VALUE] + "…"


def utc(when):
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def gap(when, at):
    """Describe how far a line's time is from the submission time."""
    seconds = (when - at).total_seconds()
    size = abs(seconds)
    amount = (f"{size:.1f} s" if size < 120 else f"{size / 60:.0f} min" if size < 7200
              else f"{size / 3600:.1f} h")
    return f"{amount} {'after' if seconds > 0 else 'before'} the feedback"


def entries(path):
    """Return the file's readable lines, oldest first, and how many lines it could not read."""
    readable, unreadable = [], 0
    with open(path, encoding="utf-8", errors="replace") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                entry = None
            when = moment(entry.get("time")) if isinstance(entry, dict) else None
            if when is None:
                unreadable += 1
                continue
            fields = entry.get("fields")
            entry["fields"] = fields if isinstance(fields, dict) else {}
            entry["when"] = when
            readable.append(entry)
    readable.sort(key=lambda entry: entry["when"])
    return readable, unreadable


def failed_call(entry):
    """Report whether a line is an API call that failed: a 4xx or 5xx answer, or none at all."""
    fields = entry["fields"]
    if entry.get("category") != "api" or entry.get("message") != "Request finished":
        return False
    status = fields.get("status")
    return (isinstance(status, int) and status >= 400) or fields.get("outcome") == "failed"


def line(entry):
    fields = " ".join(f"{text(key)}={text(value)}" for key, value in sorted(entry["fields"].items()))
    return (f"{utc(entry['when'])}  {text(entry.get('level', '?'))}  {text(entry.get('category', '?'))}  "
            f"{text(entry.get('message', ''))}  {fields}").rstrip()


def summarize(path, at, before, after):
    readable, unreadable = entries(path)
    print(f"{path.name}: {len(readable)} lines, {unreadable} unreadable")
    if not readable:
        return
    first, last = readable[0]["when"], readable[-1]["when"]
    print(f"  Span: {utc(first)} to {utc(last)}; its last line is {gap(last, at)}")

    launches = {}
    for entry in readable:
        launches.setdefault(text(entry.get("launch", "?")), []).append(entry["when"])
    started = [launch for launch, times in launches.items() if times[0] <= at]
    feedback_launch = max(started, key=lambda launch: launches[launch][0]) if started else None
    print("  Launches, oldest first:")
    for launch, times in launches.items():
        mark = "  <- the feedback's launch" if launch == feedback_launch else ""
        print(f"    {launch}  {utc(times[0])} to {utc(times[-1])}  {len(times)} lines{mark}")

    sending = [entry for entry in readable if entry.get("message") == SENDING]
    for entry in sending:
        print(f"  {SENDING}: {utc(entry['when'])}, {gap(entry['when'], at)}")
    if not sending:
        print(f"  {SENDING}: not in this log")

    start, end = at - before, at + after
    window = [entry for entry in readable if start <= entry["when"] <= end]
    levels = ", ".join(f"{level} {count}" for level, count in
                       sorted(Counter(text(entry.get("level", "?")) for entry in window).items()))
    print(f"  Window {utc(start)} to {utc(end)}: {len(window)} lines{f' ({levels})' if levels else ''}")
    for entry in window:
        print(f"    {line(entry)}")
    failures = [entry for entry in window if failed_call(entry)]
    print(f"  Failed API calls in the window: {len(failures)}")
    for entry in failures:
        fields = entry["fields"]
        answer = f"status {fields['status']}" if "status" in fields else "no answer"
        print(f"    {utc(entry['when'])}  {text(fields.get('method', '?'))} {text(fields.get('route', '?'))}  "
              f"{text(answer)}  request_id={text(fields.get('request_id', 'none'))}")


def main():
    parser = argparse.ArgumentParser(prog="summarize_log_tails.py", description=__doc__.splitlines()[0])
    parser.add_argument("--at", required=True, type=submission, help="the feedback's submission time")
    parser.add_argument("--before", type=minutes, default=timedelta(minutes=10),
                        help="minutes of the window before --at (default 10)")
    parser.add_argument("--after", type=minutes, default=timedelta(minutes=1),
                        help="minutes of the window after --at (default 1)")
    parser.add_argument("files", nargs="+", type=Path, metavar="FILE")
    args = parser.parse_args()
    missing = [str(path) for path in args.files if not path.is_file()]
    if missing:
        parser.error(f"no such log tail: {', '.join(missing)}")
    print(f"Feedback sent at {utc(args.at)}")
    for path in args.files:
        summarize(path, args.at, args.before, args.after)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
