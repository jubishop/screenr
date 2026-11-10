# Sentry helper response contracts

The `analyze-sentry-issue` and `analyze-sentry-feedback` skills share these
helpers, adapted from PodHaven's. They read Sentry organization
`artisanal-software` through the installed, authenticated `sentry` CLI,
verified with version 0.45.0, and accept only Screenr's projects,
`screenr-ios` and `screenr-server`.

| Helper | Reads |
| --- | --- |
| `fetch_issue_bundle.sh` | An error issue, representative events, and tag distributions |
| `fetch_feedback_bundle.sh` | A `screenr-ios` feedback item, its event, activity, notes, and attachment metadata |
| `download_event_attachments.sh` | An event's attachment list, and the attachments named |
| `search_related_errors.sh` | Error events in both projects that match a query in a time window |
| `fetch_server_journal.py` | The `screenr-web` and `screenr-worker` journal for a time window, over SSH |
| `summarize_log_tails.py` | The log tails that feedback attaches, around the time it was sent |
| `find_tracking_issues.py` | The GitHub issues that track one Sentry issue or feedback item |

Each helper that saves evidence writes it to a fresh path that the caller
names. Keep those paths outside the repository: they hold Sentry data and
journal lines, which can identify members.

## Sentry API envelope

`sentry api <endpoint> --json` returns an HTTP response envelope with an integer
`status`, a `statusText`, and a `body`. `sentry_api_json` in `lib.sh` requires a
successful CLI exit, a 2xx HTTP status, and the expected endpoint payload type.
It writes only the validated `body` to the destination. Bare API arrays,
malformed JSON, missing fields, and unexpected types are errors. Diagnostics
name the endpoint without printing the response body. A tag value may be
null: Sentry counts the events without the tag, such as a signed-out app's
events without a user, under a null value, which the bundle summary shows as
`(not set)`.

## Bundle files

| File | Shape |
| --- | --- |
| `issue.json` | Native `issue view --json` object, unchanged |
| `events.json` | Native `issue events --json` object with a `data` list; feedback API fallback wraps the validated event list in `data` |
| `event_<id>.json` | Full event object, including nested `entries[].data` |
| `events_raw.json` | Validated API event list, present only for feedback fallback |
| `tags_<key>.json` | List of tag values and counts |
| `attachments.json` | List of attachment metadata |
| `activities.json` | Object with an `activity` list |
| `notes.json` | List of notes |

An error bundle reads the `environment`, `release`, `device`, `os`, and `user`
tags of a `screenr-ios` issue, and the `environment`, `event`, and
`request_id` tags of a `screenr-server` issue, which names no release.

Tag distributions, activities, and notes are optional evidence. A failed
request prints its error and an unavailable warning, omits that payload file,
and labels the evidence unavailable in the summary. Missing files do not mean
zero results. Successful empty lists are saved and reported as empty. Required
attachment metadata and feedback fallback failures stop the helper. Feedback
with no events stops with an explicit diagnostic.

Native issue and explore commands have separate contracts. They do not use
the API envelope parser. Attachment download endpoints return raw bytes;
downloads bypass JSON parsing and preserve those bytes exactly. The CLI reads
a period's times without a zone as local time, so give them in UTC with `Z`,
such as `2026-11-08T20:00:00Z..2026-11-08T20:30:00Z`.

## Server journal

`fetch_server_journal.py` runs only `journalctl` for `screenr-web` and
`screenr-worker` on the host, over SSH as the owner, and changes nothing
there. It takes the window's start and end in UTC, writes every line in the
window to its output file, and prints only counts: failure lines by `event`,
those whose `requestId` matches `--request-id`, and the oldest line the
journal still keeps. A window that starts before that line has lost its
earlier lines, so an empty result there is not evidence of no failures. The
[failure logs](../../../docs/deployment.md#failure-logs) describe the lines.
Public files write the host as `root@YOUR_SSH_HOST`; the owner's home
instructions say where to find it.

## Log tails

`summarize_log_tails.py` reads downloaded log tails, such as `app.ndjson`
and `notifications.ndjson`, whose lines the
[logging section](../../../ios/README.md#logging) describes, and the
feedback's submission time in UTC. For each file it prints its time span and
how far its last line is from that time, its launches with the one the
feedback came from marked, when the app logged `Sending feedback`, every line
in a window around the submission, 10 minutes before to 1 minute after by
default, and the window's failed API calls: a 4xx or 5xx answer, or none,
with their request IDs. It counts lines it cannot read without printing them,
and replaces control characters in what it prints. The lines hold no member
content by design, but their user and request IDs stay out of GitHub.

## Tracking issues

`find_tracking_issues.py` reads every issue in `GH_REPO`, or
`jubishop/screenr`, through `gh`. It matches the
`<!-- sentry-issue:<numeric-id> -->` marker or a Sentry link to the issue, or
for feedback the `<!-- sentry-feedback:screenr-ios:<numeric-id> -->` marker or
a feedback link, and trusts a match only when the intake's `github-actions`
bot or the repository's owner opened the issue. It lists untrusted matches
separately. Each issue shows whether its body holds the skill's complete
findings block. The
[daily Sentry intake](../../../docs/development-workflow.md#daily-sentry-intake),
`bin/sentry-intake`, imports its matching, so the intake, the skills, and the
pickers agree on which issue tracks an item.

With `--states`, it prints one line per ID instead, the ID, a tab, and the
state of its canonical issue: `#<n> intake`, `#<n> analyzed`, `#<n> closed`,
or `untracked`. The canonical issue is a trusted match, open before closed,
then with the marker, then the newest. An error issue's `## Sentry closeout`
from before the marker counts as analysis.
[`bin/snissue` and `bin/snfeedback`](../../../docs/development-workflow.md#sentry-triage-commands)
show these states, and each skill's list of unresolved items uses them.

## Tests

`tests/test_sentry_cli_helpers.py` runs every helper against fake `sentry`,
`gh`, and `ssh` commands and synthetic log tails, and `bin/check --full` runs
it. Never copy real issue fields, feedback, journal lines, log tails, or
attachment bytes into test fixtures.
