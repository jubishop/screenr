# Screenr Sentry correlation

Load only the sections relevant to the issue being diagnosed. Keep every
output in the invocation's working directory, and never copy what it shows
into GitHub; see the skill's privacy rules.

## Builds and known fixes

- **App:** each event names its build as the release
  `com.artisanalsoftware.Screenr@<version>+<build>`, with the build as its
  dist. Build `<build>` of version `<version>` is the commit tagged
  `ios-v<version>b<build>`, such as `ios-v1.0b4`
  ([TestFlight releases](../../../../docs/development-workflow.md#testflight-releases)).
  Events carry no commit hash.
- **Server:** events name no release. Releases live on the host as
  `/opt/screenr/releases/<revision>`, and `readlink /opt/screenr/current` names
  the active one. For an event older than the kept releases, read the
  `deploy` job logs of the `check` runs on `main` before it: the job also
  succeeds when it skips a deployment.

Search memory, docs, and closed GitHub issues for matching failures and
concrete fix commits. Use
`git merge-base --is-ancestor <fix-commit> <build-commit>` to determine whether
the failing build contains a suspected fix. A recurrence in a containing build
means the fix is incomplete.

## Request IDs across the app and the server

The app sends a `Screenr-Request-Id` with every API call, and the server
answers with the same ID, or its own when the app's is malformed. The ID
appears as:

- the `request_id` tag of an app error captured with its request, and of the
  app's `http` breadcrumbs and `http.client` transactions;
- the `request_id` tag of a `screenr-server` event, and `requestId` in its
  failure context;
- `requestId` in the server's journal line for that failure.

Search both projects for a request's errors with `search_related_errors.sh`,
such as `--query 'request_id:<id>'` over a window around the event. Give
range times in UTC with `Z`. The [iPhone app's Sentry
settings](../../../../ios/README.md#sentry) and the [server's failure
reports](../../../../docs/deployment.md#failure-reports-in-sentry) describe
what each side sends.

App events carry the Sentry user only while a member is signed in, as an
opaque Screenr user ID; the `user` tag then counts members. Signed-out events
have none, and the bundle shows their user tag as `(not set)`. To see what
else one member's app reported near the event, search errors with
`--query 'user.id:<id>'`, and the app's Sentry logs, which hold warnings and
above from Release builds:

```bash
sentry explore artisanal-software/screenr-ios --dataset logs \
  --field timestamp --field severity --field message --field request_id \
  --query 'user.id:<id>' --period '<start>Z..<end>Z' --limit 100 --json
```

Start with 10 minutes on either side of the event and widen to 30 when that
is too sparse. A result far from the event time means correlation failed.
Report the correlation key, period, and relevant timeline in Pacific Time.

## Server journal

For a `screenr-server` issue, read the journal around each representative
event. The journal keeps every failure line, while Sentry gets each kind of
failure at most once an hour; a report with `folded` in its failure context
counts the failures folded since the kind's last report, and its time is when
that hour ended
([failure reports](../../../../docs/deployment.md#failure-reports-in-sentry)).

```bash
python3 -I .agents/scripts/sentry-cli/fetch_server_journal.py \
  --host root@YOUR_SSH_HOST --since <start>Z --until <end>Z \
  --request-id <id> --out <dir>/journal-<event-id>.txt
```

Take the host from the owner's home instructions; public files keep the
placeholder. Use a window of 10 minutes on either side of the event, or the
whole hour before a folded report. The summary counts failure lines by
`event`, and those of the request; read the output file for the surrounding
lines, such as Next's `⨯` line or Better Auth's own line beside a failure. The
[failure logs](../../../../docs/deployment.md#failure-logs) describe each
event and its fields. A window that starts before the journal's oldest kept
line has lost its earlier lines: report that the journal no longer reaches
the event rather than that no failures happened.

## Reporting checks

The deployment runbook confirms server reporting by sending a test failure,
`Error: sentry check`, tagged `event:sentry check` and
`request_id:sentry-check`
([failure reports](../../../../docs/deployment.md#failure-reports-in-sentry)).
An issue whose events are all such checks is not a defect: record that, with
the times of the checks, and close it as the skill's Step 6 says.

## Attachments

Screenr's error events normally carry no attachments, since screenshots and
the view hierarchy are off; feedback carries the log tails. When an event
does list attachments, list them with `download_event_attachments.sh` before
downloading any, and download only those that can affect the diagnosis, each
selection into a fresh, nonexistent directory. The helper leaves an
`.incomplete` marker after a failed or interrupted download; analyze only a
destination without one.
