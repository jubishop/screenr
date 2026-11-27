---
name: analyze-sentry-issue
description: >-
  Diagnose one Screenr Sentry error issue from screenr-ios or screenr-server,
  and record sanitized findings in its GitHub tracking issue through closeout.
  Use when the user gives a Sentry issue URL, a short ID such as
  SCREENR-IOS-2, or a numeric issue ID, or asks what caused a Screenr Sentry
  error and how to address it; with no reference, it lists the unresolved
  error issues to pick from. Also use when fix-issue meets this skill's
  prerequisite marker.
disable-model-invocation: false
argument-hint: "[issue-url|short-id|id] [notes]"
---

# Analyze Sentry Issue

Diagnose what failed, who it affects, its most likely cause, and the best fix
or mitigation, and track the result in one GitHub issue. Screenr reports to
Sentry organization `artisanal-software` in two projects: `screenr-ios`, the
iPhone app, and `screenr-server`, the web and worker services. Use
`analyze-sentry-feedback` for Sentry feedback.

Read the `track-sentry-findings` skill first and follow it throughout: it
holds the rules this skill shares with the other Sentry analysis skills, the
tracking review Step 2 runs, and the GitHub tracking Step 6 hands off to.
Beyond those rules:

- Treat user notes as scope, constraints, or hypotheses to test, not evidence.
- Read the production host only, never change it: the journal helper runs only
  `journalctl`.

## `fix-issue` prerequisite contract

This skill may serve as a `fix-issue` prerequisite through the marker
`<!-- fix-issue-prerequisite: analyze-sentry-issue <numeric-id> -->`, whose
argument is the numeric Sentry issue ID. Beyond the authenticated user, it
trusts markers only from `github-actions[bot]`, the daily intake workflow's
login:

<!-- fix-issue-trusted-marker-author: github-actions[bot] -->

A complete block from `<!-- analyze-sentry-issue-findings:start -->` through
`<!-- analyze-sentry-issue-findings:end -->` in the issue body is the
completion signal.

## Helpers

Run the helpers in `.agents/scripts/sentry-cli/` from the repository root;
their [response contracts](../../scripts/sentry-cli/README.md) describe each
output.

## Step 0: No reference given? List unresolved issues

When invoked with no issue reference, and none is obvious from the
conversation, list the unresolved issues instead of asking for one. Run this
for `screenr-ios` and for `screenr-server`:

```bash
sentry issue list artisanal-software/<project> \
  --query 'is:unresolved !issue.category:feedback' \
  --period 90d --limit 1000 --sort new --fresh --json \
  --fields id,shortId,title,level,count,userCount
```

Stop and report it if either list fails or says it has more rows; never offer
a partial list. Pass every numeric ID to one
`find_tracking_issues.py --states --issue <id> ...` call for each one's GitHub
state. Present the entries newest first, one line each:
`SCREENR-IOS-2  <numeric-id> — <title> (<level>; <N> events; <N> users;
GitHub: #N intake|#N analyzed|#N closed|untracked)`. Let the user choose one,
and treat anything typed alongside the pick as triage notes. If nothing is
unresolved, say so and stop.

## Step 1: Resolve the reference

Resolve the URL or ID to the numeric ID, short ID, project, permalink, status,
and substatus with `sentry issue view <reference> --fresh --json`. Stop unless
the project is `screenr-ios` or `screenr-server`. Tell the user the short ID
and numeric ID in one line before fetching evidence, and echo any notes.

If Sentry cannot find the issue, look for an `issue.delete` entry naming its
numeric ID with
`sentry api 'organizations/artisanal-software/audit-logs/?event=issue.delete&per_page=100'`.
Report whether it was deleted or most likely aged out of retention, then
continue from the GitHub history alone.

## Step 2: Find the tracking issue and history

Review the tracking history as `track-sentry-findings` describes, listing the
tracking issues, open and closed, with
`find_tracking_issues.py --issue <numeric-id>`, which marks the untrusted
ones and counts an older issue's `## Sentry closeout` as analysis. The daily
intake, `bin/sentry-intake`, titles its placeholder
`Triage Sentry issue <shortId>` or `Triage recurrence of Sentry issue <shortId>`.
Search for the same failure by the server's `event` and its fields too.

## Step 3: Fetch the evidence

Fetch the issue into the triage's working directory, `<dir>`, with
`fetch_issue_bundle.sh <reference> --out <dir>/issue`.
Apply an `--event-query` only when the user scoped the investigation, and
never treat an empty filtered result as a representative sample. A missing
tag distribution is unavailable evidence, not a zero count.

Inspect enough actual events to explain meaningful variation across time,
build, device, OS, or other dominant clusters. Prefer in-app stack frames and
thread states, then the breadcrumbs just before the error. Record relevant
exception details, tags, request IDs, release and dist, trace context, and a
server event's failure context. Use tag distributions and event samples to
judge impact and whether the issue is isolated, recurring, or regressing.
When a linked trace could change the diagnosis, fetch its span context with
the bundle's `--spans` option and analyze only the relevant path; otherwise
don't imply that the full trace was analyzed.

Follow the failure across the app and the server, which share request IDs, and
into the production journal for a server issue. Read
[Screenr correlation](references/screenr-correlation.md) and follow the
sections that apply, and for a MetricKit event,
[MetricKit diagnostics](references/metrickit-diagnostics.md).

## Step 4: Trace the failure

Trace the failure through the current codebase, its recent history, and its
tests. If an event does not match the current tree, explain the drift from
stable symbol names and history.

For a recurrence, or a failure that resembles a known fix, test each event's
build against the earlier fix as
[builds](references/screenr-correlation.md#builds-and-known-fixes) describes,
and state each result. Events only from builds that predate the fix are a
stale build, not a new defect; an event from a build that contains the fix
means the fix is incomplete.

## Step 5: Synthesize

Lead with what failed and who it affects, then the direct observations from
representative events, the journal, and the code. Include:

- The inferred root cause, confidence, and what would raise confidence.
- Material alternatives and why the evidence favors or rejects them.
- A code, operational, or monitor/defer recommendation with the relevant files,
  functions, and regression tests.
- Open questions only when their answers could change the decision.

If evidence sources disagree or correlation fails, say so directly.

## Step 6: Track the findings in GitHub

Track the findings as `track-sentry-findings` describes, in `jubishop/screenr`
with the `sentry-issue` label. Proposed diagnostics stay within the privacy
rules in `ios/README.md#sentry` for the app and
`docs/deployment.md#failure-logs` for the server, whose diagnostics may
deliver their evidence to the journal as well as to Sentry.

Beyond the shared labels, add `area: ios` for a `screenr-ios` issue and
`area: server` for a `screenr-server` one, or another area the findings
implicate, and `investigation` while the outcome is a finding or decision.
When the findings define work, relabel it `bug` for a defect to fix, or
`improvement` for diagnostics to add.

Close a [reporting check](references/screenr-correlation.md#reporting-checks),
a failure sent on purpose, as `track-sentry-findings` closes a stale build's
issue.

Use this body shape:

```markdown
<!-- sentry-issue:<numeric-id> -->
This issue tracks [Sentry issue `<shortId>`](<permalink>) (numeric issue ID `<numeric-id>`) in `<project>`.

<!-- analyze-sentry-issue-findings:start -->
## Findings

- **Observed vs. expected:** <sanitized behavior>
- **Affected scope:** <builds, environments, member and device counts, frequency>
<the shared findings fields>

## Sentry record

- **Title:** <sanitized Sentry issue title>
- **Exception:** <type and mechanism, or the server line's event and error class and code>
- **Top in-app frames:** <symbolicated function names>
- **Seen:** <first and last seen in PT; event and user counts>
- **Builds:** <app releases and their build tags, or the server revisions; environments>
- **OS:** <affected versions, or "Not applicable" for the server>

<the shared resolution sections>

## Sentry closeout

- When this issue's work is done, or it closes without a fix, such as a
  stale-build recurrence, close [Sentry issue `<shortId>`](<permalink>)
  (numeric issue ID `<numeric-id>`) with
  `bash .agents/scripts/sentry-cli/close_sentry_issue.sh <numeric-id>`, which
  resolves it and reads it back, adding `--archive` when the error is
  accepted as expected behavior.
<the shared closeout handoff>
<!-- analyze-sentry-issue-findings:end -->
```

### Privacy

Beyond what `track-sentry-findings` keeps out of GitHub and committed files,
keep out anything that could identify a member or show what they did:

- Usernames.
- Titles, people, or pages they acted on, and route values such as a
  username or title ID.
- Error messages and breadcrumbs as recorded, which can quote failing values.
- Device models and anything else that singles out one of a few members'
  devices, such as an unusual model or OS build.
- The production host's address; write `root@YOUR_SSH_HOST`.

Describe the failure also by route patterns such as `/people/:username`,
error codes, and the server's `event` names and field names.
