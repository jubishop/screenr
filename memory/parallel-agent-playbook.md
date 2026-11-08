---
name: parallel-agent-playbook
description: How an orchestrator briefs, runs, reviews, and merges several issue agents at once in Screenr, from the 2026-10-14 and 2026-10-25 runs.
type: reference
---

# Parallel agent playbook

This is how one orchestrating session worked through many Screenr issues with
parallel agents on 2026-10-14 and again on 2026-10-25. It replaces the agent
briefs once pinned as td notes, which were retired with td. The pitfalls that
shaped it are in [parallel agent gotchas](parallel-agent-gotchas.md).

## Before launching agents

- **Pick work by blockers and assignment:** follow the blocked and assigned
  rules in `~/AGENTS.md`. Assign each issue as its agent starts. A reopened
  issue's last comment names the exact gap left.
- **Create worktrees serially:** run `ghcw issue<N>-wt` from the primary
  checkout, one at a time. Each run fetches and fast-forwards the primary
  checkout, so parallel runs race.
- **Unblock CI first:** when `main`'s CI is failing, land that fix before
  agents open pull requests, or every one of them fails the same way.

## What each agent is told

Write one shared brief and give each agent its issue number, worktree, and
any issue-specific notes. The shared brief covers:

- **Reading:** `AGENTS.md`, the engineering policy, the issue with its
  comments, and, for iOS, `ios/AGENTS.md` and `ios/README.md`.
- **Isolation:**
  - Work only in its own worktree. Git installs its npm packages and
    Playwright's Chromium when it creates the worktree; if that install
    failed, rerun `bin/setup-application` there.
  - Leave `TEST_DATABASE_URL` unset; each checkout derives its own test
    databases, and later test runs drop those of removed worktrees.
  - Create and delete its own Simulator.
  - Keep scratch files inside the worktree, never in the orchestrator's
    scratch directory.
- **iOS checks:** run `bin/check-ios` before pushing; it waits for one of
  three machine-wide slots on its own. Never use `--no-verify`.
- **Red-green and docs:** a failing test first, root-cause fixes, and the docs
  the issue names.
- **Landing:**
  - Commit messages follow `~/.jeeves_prompt`.
  - Rebase on `origin/main` and open a pull request whose body maps each
    "Done when" item to its evidence. It says `Closes` only when merging meets
    every item, and `Refs` plus the remainder otherwise.
  - Wait for CI in the foreground with `gh pr checks <pr> --watch`.
  - **Do not merge.** Report the pull request, what's left, and anything the
    next issues need.

## Reviewing and merging

- **The orchestrator merges:** it reads each diff, or spawns an independent
  reviewer for large ones, and sends findings back with `SendMessage`. It
  merges with `gh pr merge --squash --delete-branch`, which also removes the
  agent's local worktree.
- **Squash messages:**
  - Write them with `~/.jeeves_prompt`, ending with the `Co-Authored-By`
    trailer.
  - Add `Screenr-Deploy: skip` trailers only when nothing runs in production.
    Name the deployed revision from `gh api repos/jubishop/screenr/deployments`.
- **iOS batches:** pull requests whose iOS files don't overlap can merge
  without rebasing, since each passed `bin/check-ios` on its own tree. Then run
  one `bin/check-ios` on `main` in a detached worktree to verify the combined
  result, and fix any failure at once.
- **Production steps:** some issues need host work after the merge, such as
  installing the deploy kit. Have the agent verify on the host before the
  merge, read-only, and then roll out with the documented checks and rollback.
- **Device checks:** don't hold an issue open for a check only the owner's
  iPhone can make. Once the automated and production checks pass, close it
  with a note saying what no real device has shown yet. The owner files an
  issue if something fails in use (the owner's choice, 2026-11-08, after
  test plans for #340, #540, and #250 grew too heavy).
- **Dependabot:** when `@dependabot rebase` stalls, `gh pr update-branch
  <pr> --rebase` restarts its CI.

## Other sessions

Sessions that share Project Starter or the fleet are visible with
`ListAgents`. Before a Starter release or fleet sync, message them and wait
for their syncs to finish, so two syncs never touch the same adopters at once.
