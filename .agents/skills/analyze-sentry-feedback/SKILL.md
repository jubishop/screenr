---
name: analyze-sentry-feedback
description: >-
  Diagnose one feedback item that a member sent from Screenr's iPhone app to
  Sentry's screenr-ios project, and record sanitized findings in its GitHub
  tracking issue through closeout. Use when the user gives a Sentry feedback
  URL, a slug such as screenr-ios:<id>, or a numeric feedback ID, or asks to
  investigate Screenr feedback; with no reference, it lists the unresolved
  feedback to pick from. Also use when fix-issue meets this skill's
  prerequisite marker.
disable-model-invocation: false
argument-hint: "[feedback-url|screenr-ios:<id>|id] [notes]"
---

# Analyze Sentry Feedback

Diagnose what a member ran into, its most likely cause, and the best fix or
next step, and track the result in one GitHub issue. Members send feedback
from the app's Send feedback form
([Feedback](../../../ios/README.md#feedback)) to Sentry organization
`artisanal-software`, project `screenr-ios`, as a feedback issue whose one
event carries the message, up to three `screenshot-<n>.jpg` attachments, and
a log tail for each process that has logged, such as `app.ndjson` and
`notifications.ndjson`.

Read the `track-sentry-findings` skill first and follow it throughout: it
holds the rules this skill shares with the other Sentry analysis skills, the
tracking review Step 2 runs, and the GitHub tracking Step 6 hands off to.
Beyond those rules:

- Treat user notes as scope, constraints, or hypotheses to test, not evidence.
- Read the production host only, never change it: the journal helper runs only
  `journalctl`.

## `fix-issue` prerequisite contract

This skill may serve as a `fix-issue` prerequisite through the marker
`<!-- fix-issue-prerequisite: analyze-sentry-feedback screenr-ios:<numeric-id> -->`,
whose argument is the slug. Beyond the authenticated user, it trusts markers
only from `github-actions[bot]`, the daily intake workflow's login:

<!-- fix-issue-trusted-marker-author: github-actions[bot] -->

A complete block from `<!-- analyze-sentry-feedback-findings:start -->`
through `<!-- analyze-sentry-feedback-findings:end -->` in the issue body is
the completion signal.

## Helpers

Run the helpers in `.agents/scripts/sentry-cli/` from the repository root;
their [response contracts](../../scripts/sentry-cli/README.md) describe each
output.

## Step 0: No reference given? List unresolved feedback

When invoked with no feedback reference, and none is obvious from the
conversation, list the unresolved feedback instead of asking for one:

```bash
sentry issue list artisanal-software/screenr-ios \
  --query 'issue.category:feedback is:unresolved' \
  --period 90d --limit 1000 --sort new --fresh --json \
  --fields id,shortId,metadata.message
```

Stop and report it if the list fails or says it has more rows; never offer a
partial list. Pass every numeric ID to one
`find_tracking_issues.py --states --feedback <id> ...` call for each one's
GitHub state. Present them newest first, one line each with the short ID,
slug, message trimmed to one line, and GitHub state. Let the user choose one,
and treat anything typed alongside the pick as triage notes. If nothing is
unresolved, say so and stop.

## Step 1: Resolve the reference

Take the numeric ID from a feedback URL's `feedbackSlug=` value, an issue
URL's `/issues/<id>/` part, a slug's part after `screenr-ios:`, or a bare
number, and read it with
`sentry issue view <numeric-id> --fresh --json --fields id,shortId,project,issueCategory,permalink,status,substatus`.
Stop unless the project is `screenr-ios` and the category is `feedback`; an
error issue belongs to `analyze-sentry-issue`. Tell the user the slug and
short ID in one line before fetching evidence, and echo any notes.

If Sentry cannot find the feedback, look for an `issue.delete` entry naming
its numeric ID with
`sentry api 'organizations/artisanal-software/audit-logs/?event=issue.delete&per_page=100'`.
Report whether it was deleted or most likely aged out of retention, then
continue from the GitHub history alone.

## Step 2: Find the tracking issue and history

Review the tracking history as `track-sentry-findings` describes, listing the
tracking issues, open and closed, with
`find_tracking_issues.py --feedback <numeric-id>`, which marks the untrusted
ones. The daily intake, `bin/sentry-intake`, titles its placeholder
`Triage Sentry feedback <shortId>`.

## Step 3: Fetch the evidence

### The feedback

Fetch it into the triage's working directory, `<dir>`, with
`fetch_feedback_bundle.sh screenr-ios:<numeric-id> --out <dir>/bundle`.
The message is `metadata.message`, or else the event's
`contexts.feedback.message`; Sentry's summary, title, and `ai_categorization`
tags only paraphrase it. From the event, also read
`user.id`, the member's opaque Screenr user ID, absent when signed out; the
`dist` tag and the device and OS contexts; and the linked error,
`contexts.feedback.associated_event_id`, which Screenr's form never sets.
Read the owner's notes in `notes.json` and Sentry's activity, such as a spam
flag, in `activities.json`, in time order.

Show the user a short private header: the submission time, the release,
signed in or out, the attachments, and the message quoted verbatim.

### Attachments

Download the feedback event's attachments into a fresh directory:

```bash
bash .agents/scripts/sentry-cli/download_event_attachments.sh \
  --event <event-id> --issue-json <dir>/bundle/issue.json \
  --dir <dir>/attachments --all
```

Analyze them only once the helper succeeds, retrying into a fresh directory
after a failure. No attachments at all means the member sent none and the app
had no log to attach; say so.

- **Screenshots:** view each `screenshot-<n>.jpg` for the screen and state the
  member describes.
- **Log tails:** summarize them around the submission time:

```bash
python3 -I .agents/scripts/sentry-cli/summarize_log_tails.py \
  --at <submission-time> <dir>/attachments/*.ndjson
```

The app logs `Sending feedback` as it gathers the tails; when that line is
missing or far from the submission, or the tail ends long before it, say so
and weigh the timeline less. Tails hold info and above, at most 256 KB each:
successful polls log only at debug, and a busy session may have pushed the
problem's start out. Widen a sparse window with `--before 30`.

### Build and known fixes

Find the release's build commit, and test it against any fix that resembles
the feedback, as
[builds](../analyze-sentry-issue/references/screenr-correlation.md#builds-and-known-fixes)
describes, stating each ancestry result: a build that predates the fix is a
stale build, not a new defect, and one that contains it means the fix is
incomplete. Look through what the app has shipped since, such as with
`git log --oneline <build-commit>..origin/main -- ios/`, for a later change
that already fixes or alters what the member saw.

### Errors near the feedback

Members usually write right after something goes wrong, so the error behind
the feedback is often one that Sentry did not link to it. Search both projects
from 10 minutes before the submission to 1 minute after, widening the start to
30 minutes when that is empty:

```bash
bash .agents/scripts/sentry-cli/search_related_errors.sh \
  --period '<start>Z..<end>Z' --query 'user.id:<id>' \
  --out <dir>/related-user.json
```

Server events carry no user, so also search by the request IDs of the tails'
failed calls, such as `--query 'request_id:[<id>,<id>]'`. With no user, fall
back to `release:<release>` and say that matches are release-wide. Read the
member's Sentry logs as
[request IDs](../analyze-sentry-issue/references/screenr-correlation.md#request-ids-across-the-app-and-the-server)
shows. Read each related issue only far enough to connect it to the feedback,
and find its tracking issue with `find_tracking_issues.py --issue <id> ...`;
its own diagnosis belongs to `analyze-sentry-issue`.

### Server journal

When the log tails show calls that got a 5xx answer or none, read the journal
around them by request ID, as the
[server journal](../analyze-sentry-issue/references/screenr-correlation.md#server-journal)
section describes. A 4xx answer is the server's designed response, which the
journal does not record as a failure; trace it in the route's code instead.

## Step 4: Trace the behavior

Decide what the feedback is: a defect, a request for something new, or
confusion about how Screenr is meant to work. Trace the screen and action that
the message, screenshots, and log tails point to through the current codebase:
the SwiftUI screen, its ScreenrKit model, the API route, and the server code
behind it. Compare the iPhone app with the web client when they should behave
alike
([interface parity](../../../docs/ios-app.md#system-look-with-screenr-colors-and-logo--2026-10-13)),
and check the product docs before calling intended behavior a defect.

A test report sent on purpose, such as those that verified
[#567](https://github.com/jubishop/screenr/issues/567), names an environment
such as `issue-<n>-verification` and an SDK such as `screenr-issue-<n>`,
which the app never sends. It is not a member's report: record that, and
close its issue as `track-sentry-findings` closes a stale build's.

## Step 5: Synthesize

Give the user one private report. Lead with what the member experienced,
quoting the message verbatim, then the evidence with a short timeline, the
verdict, and the recommendation. Weigh the evidence roughly in this order:
prior conclusions from Step 2; Sentry notes added after the report; a linked
or nearby error event and its stack; failed requests and their journal lines;
the log tails' timeline; the screenshots; and the message itself, which frames
the experience but is often imprecise about cause. Include:

- What kind of feedback it is, the inferred root cause, confidence, and what
  would raise confidence.
- Material alternatives and why the evidence favors or rejects them.
- A code, operational, product, or monitor/defer recommendation with the
  relevant files, functions, and regression tests.
- Open questions only when their answers could change the decision.

If evidence sources disagree or correlation fails, say so directly.

## Step 6: Track the findings in GitHub

Track the findings as `track-sentry-findings` describes, in `jubishop/screenr`
with the `sentry-feedback` label. Proposed diagnostics may deliver their
evidence as a log line in the tails that feedback attaches, as well as to
Sentry, within the privacy rules in `ios/README.md#sentry` and
`ios/README.md#logging`.

Beyond the shared labels:

- **Type and area:** `area: ios`, plus `area: server` or `area: ui` when the
  findings implicate them, and `investigation` while the outcome is a finding
  or decision. When the findings define work, relabel it `bug`,
  `improvement`, such as for diagnostics to add, or `feature`.
- **Product choices:** a request for something new, or a report of behavior
  that works as designed, waits on the owner's product choice. Add
  `needs decision`, write any proposal as an option, never as a decision, and
  close the issue only on the owner's disposition.

A new issue uses this body shape; an intake issue keeps its own lines in
place of the first two.

```markdown
<!-- sentry-feedback:screenr-ios:<numeric-id> -->
This issue tracks [Sentry feedback `<shortId>`](<permalink>) (`screenr-ios:<numeric-id>`).

<!-- analyze-sentry-feedback-findings:start -->
## Findings

- **Reported behavior:** <paraphrase without names, titles, or quotes>
- **Kind:** <defect, request, or expected behavior>
<the shared findings fields>

## Sentry record

- **Feedback:** sent <PT date> from build `<release>` (tag `ios-v<version>b<build>`), <signed in or signed out>; <N> screenshots; log tails <names, or "none">
- **Screen:** <the screen and its interface state, without content>
- **Related Sentry issues:** <for each, the linked short ID, sanitized title, exception, top in-app frames, and tracking issue; or "None">
- **Server failures:** <the journal's `event` names and counts near the report, "None", or why the journal was not read>

<the shared resolution sections>

## Sentry closeout

- When this issue's work is done, or it closes without a fix, resolve
  [Sentry feedback `<shortId>`](<permalink>) (numeric issue ID `<numeric-id>`)
  with `bash .agents/scripts/sentry-cli/close_sentry_issue.sh <numeric-id>`,
  which reads it back. Never delete it.
- <one bullet per related Sentry issue that this work fixes and no other open
  tracking issue covers> Also close [Sentry issue `<related shortId>`](https://artisanal-software.sentry.io/issues/<related numeric-id>/)
  (numeric issue ID `<related numeric-id>`) with
  `bash .agents/scripts/sentry-cli/close_sentry_issue.sh <related numeric-id>`,
  adding `--archive` when it is accepted as expected behavior.
<the shared closeout handoff>

What the member wrote and showed stays in Sentry.
<!-- analyze-sentry-feedback-findings:end -->
```

### Privacy

Beyond what `track-sentry-findings` keeps out of GitHub and committed files,
keep out anything that could identify a member or show what they wrote, saw,
or did:

- The message closely reworded, and Sentry's generated title, summary, or
  category tags for it.
- Anything screenshots show beyond the screen and its interface state, such
  as names, photos, titles, reviews, comments, and messages.
- Launch IDs and usernames.
- Titles, people, or pages they acted on, and route values such as a
  username or title ID.
- Error messages, which can quote failing values.
- Location, which Sentry may add from the connection, device models, and
  anything else that singles out one of a few members' devices, such as an
  unusual OS build.
- The production host's address; write `root@YOUR_SSH_HOST`.

Describe the report by its screen and action, such as "a review would not
post from a title page", and also by route patterns such as
`/people/:username`, log messages and field names, error codes, and the
server's `event` names.
