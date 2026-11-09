#!/usr/bin/env python3
"""List the GitHub issues, open and closed, that track one Sentry issue or feedback item.

Usage:
  find_tracking_issues.py --issue NUMERIC_ID [NUMERIC_ID ...]
  find_tracking_issues.py --feedback NUMERIC_ID [NUMERIC_ID ...]

It reads the repository's issues once, however many IDs it is given.

An issue tracks the item through its hidden marker or a Sentry link in its
body, but only when the intake's github-actions bot or the repository's owner
opened it: in a public repository anyone can open an issue that holds a
marker or a link. Matches from other authors are listed as untrusted. The
repository is GH_REPO, or jubishop/screenr.
"""

import argparse
import json
import os
import re
import subprocess
import sys

ORGANIZATION = "artisanal-software"
FEEDBACK_PROJECT = "screenr-ios"
FILER = {"__typename": "Bot", "login": "github-actions"}  # The intake workflow's GITHUB_TOKEN.
ISSUES_QUERY = """query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $endCursor) {
      nodes { number title state stateReason body author { __typename login } }
      pageInfo { hasNextPage endCursor }
    }
  }
}"""


def patterns(kind, numeric_id):
    """Return the marker, the Sentry links, and the findings block that belong to one item."""
    issue_link = (rf"(?:{ORGANIZATION}\.sentry\.io|sentry\.io/organizations/{ORGANIZATION})"
                  rf"/issues/{numeric_id}(?!\d)")
    if kind == "issue":
        return (f"<!-- sentry-issue:{numeric_id} -->", re.compile(issue_link),
                "analyze-sentry-issue-findings")
    feedback_link = rf"feedbackSlug={FEEDBACK_PROJECT}(?:%3A|:){numeric_id}(?!\d)"
    return (f"<!-- sentry-feedback:{FEEDBACK_PROJECT}:{numeric_id} -->",
            re.compile(f"{issue_link}|{feedback_link}", re.IGNORECASE), "analyze-sentry-feedback-findings")


def trusted(author, owner):
    """Report whether an issue's author is the intake's bot or the repository's owner."""
    if not isinstance(author, dict):  # A deleted account has no author.
        return False
    kind, login = author.get("__typename"), author.get("login")
    return ({"__typename": kind, "login": login} == FILER
            or (kind == "User" and isinstance(login, str) and login.lower() == owner.lower()))


def analyzed(body, block):
    """Report whether a body holds a complete findings block, start before end."""
    start, end = body.find(f"<!-- {block}:start -->"), body.find(f"<!-- {block}:end -->")
    return 0 <= start < end


def issues(repository):
    owner, _, name = repository.partition("/")
    output = subprocess.run(
        ["gh", "api", "graphql", "--paginate", "--slurp", "-f", f"owner={owner}", "-f", f"name={name}",
         "-f", f"query={ISSUES_QUERY}"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    if output.returncode != 0:
        raise RuntimeError(f"gh could not list the issues of {repository}: {output.stderr.strip()[-500:]}")
    try:
        pages = json.loads(output.stdout)
        found = [issue for page in pages for issue in page["data"]["repository"]["issues"]["nodes"]]
    except (ValueError, TypeError, KeyError):
        raise RuntimeError("gh returned an unexpected issue list.") from None
    if any(not isinstance(issue, dict) or not isinstance(issue.get("number"), int) for issue in found):
        raise RuntimeError("gh returned an unexpected issue list.")
    return found


def report(kind, numeric_id, found, repository):
    """Print the issues that track one item, and the untrusted ones that only claim to."""
    owner = repository.partition("/")[0]
    marker, link, block = patterns(kind, numeric_id)
    tracking, untrusted = [], []
    for issue in found:
        body = issue.get("body") or ""
        has_marker, has_link = marker in body, bool(link.search(body))
        if not (has_marker or has_link):
            continue
        if not trusted(issue.get("author"), owner):
            untrusted.append(issue)
            continue
        state = (issue.get("state") or "").lower()
        if issue.get("stateReason") and state == "closed":
            state += f" ({issue['stateReason'].lower().replace('_', ' ')})"
        notes = ["marker" if has_marker else "link only"]
        if analyzed(body, block):
            notes.append("analyzed")
        elif kind == "issue" and "## Sentry closeout" in body:
            notes.append("analyzed before the marker")
        else:
            notes.append("not analyzed")
        tracking.append(f"  #{issue['number']}  {state}  {', '.join(notes)}  {issue.get('title') or ''}")

    print(f"Tracking issues for Sentry {kind} {numeric_id} in {repository}:")
    print("\n".join(tracking) if tracking else "  none")
    for issue in untrusted:
        login = (issue.get("author") or {}).get("login", "a deleted account")
        print(f"Ignored #{issue['number']}, opened by {login}, who is neither the intake bot nor {owner}.")


def main():
    parser = argparse.ArgumentParser(prog="find_tracking_issues.py", description=__doc__.splitlines()[0])
    item = parser.add_mutually_exclusive_group(required=True)
    item.add_argument("--issue", nargs="+", metavar="NUMERIC_ID", help="Sentry error issues' numeric IDs")
    item.add_argument("--feedback", nargs="+", metavar="NUMERIC_ID", help="screenr-ios feedback items' numeric IDs")
    args = parser.parse_args()
    kind, numeric_ids = ("issue", args.issue) if args.issue else ("feedback", args.feedback)
    if not all(re.fullmatch(r"[0-9]+", numeric_id) for numeric_id in numeric_ids):
        parser.error("expected numeric Sentry IDs")
    repository = os.environ.get("GH_REPO") or "jubishop/screenr"
    found = issues(repository)
    for numeric_id in numeric_ids:
        report(kind, numeric_id, found, repository)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
