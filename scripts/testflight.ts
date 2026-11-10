import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  addTester,
  appStoreConnect,
  credentialsFrom,
  distribute,
  externalGroupName,
  findApp,
  groupTesters,
  prepareReview,
  removeTester,
  testedBuild,
  type Environment,
} from "./app-store-connect";

// bin/testflight, and its alias bin/shipit: release the iPhone app to
// TestFlight from the owner's Mac, with the behavior shared with PodHaven
// (docs/ios-app.md#release-commands-shared-with-podhaven--2026-11-09). It
// moves an App Store version to its TestFlight version, drafts What to Test
// with llm, requires a clean origin/main that passes bin/check-ios, archives
// and uploads the Release app with xcodebuild, tags the commit
// ios-v<version>b<build> with the notes, and then brings the build to testers
// and Beta App Review through the App Store Connect API. Its tester flags
// instead add, remove, or list the external group's testers by email. See
// docs/development-workflow.md#testflight-releases.

const bundleId = "com.artisanalsoftware.Screenr";
const versionFile = "ios/Config/Version.xcconfig";
// Commits under these paths can change what testers see: the app and the
// server API it calls. The version file and the app's own Markdown can't.
const notePaths = [
  "ios",
  "src/server",
  "src/app/api",
  `:(exclude)${versionFile}`,
  ":(exclude,glob)ios/*.md",
];
const tagPattern = /^ios-v(\d+(?:\.\d+){0,2})b([1-9]\d*)$/;
// App Store Connect accepts What to Test notes of up to 4,000 characters.
const notesLimit = 4000;
// ios/build/release keeps the archives and logs of this many of the newest
// releases. A retry needs none of them, and the archive uploads its symbols
// to Sentry.
const releasesKept = 3;
// How long to wait for Apple to process an upload, as in PodHaven.
const timeoutVariable = "SCREENR_TESTFLIGHT_TIMEOUT_SECONDS";
const defaultTimeoutSeconds = 2 * 60 * 60;

export type Output = "capture" | "terminal" | { log: string };
export type Exec = (
  command: string,
  args: readonly string[],
  options?: { output?: Output; env?: Environment; input?: string },
) => Promise<{ status: number; stdout: string }>;

// Runs a command in the checkout. "capture" returns standard output and
// passes errors to the terminal; a log receives both streams. Input, when
// given, is the command's standard input.
export function commands(cwd: string): Exec {
  return (
    command,
    args,
    { output = "capture", env = process.env, input } = {},
  ) =>
    new Promise((resolve, reject) => {
      const log =
        typeof output === "object" ? createWriteStream(output.log) : undefined;
      const child = spawn(command, args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio:
          output === "terminal"
            ? "inherit"
            : [
                input === undefined ? "ignore" : "pipe",
                "pipe",
                log ? "pipe" : "inherit",
              ],
      });
      if (input !== undefined) child.stdin?.end(input);
      let stdout = "";
      if (log) {
        child.stdout?.pipe(log, { end: false });
        child.stderr?.pipe(log, { end: false });
      } else
        child.stdout
          ?.setEncoding("utf8")
          .on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        const result = { status: status ?? 1, stdout };
        if (log) log.end(() => resolve(result));
        else resolve(result);
      });
    });
}

export type Tag = { name: string; version: string; build: number };

// The release tags, ordered by build number.
export function releaseTags(names: readonly string[]): Tag[] {
  return names
    .flatMap((name) => {
      const match = name.trim().match(tagPattern);
      return match
        ? [{ name: match[0], version: match[1]!, build: Number(match[2]) }]
        : [];
    })
    .sort((a, b) => a.build - b.build);
}

export const nextBuild = (tags: readonly Tag[]) =>
  (tags.at(-1)?.build ?? 0) + 1;

export function marketingVersion(xcconfig: string) {
  const version = xcconfig.match(/^\s*MARKETING_VERSION\s*=\s*(\S+)\s*$/m)?.[1];
  if (!version || !/^\d+(\.\d+){0,2}$/.test(version))
    throw new Error(
      `${versionFile} must set MARKETING_VERSION to a number such as 1.0.`,
    );
  return version;
}

export const withVersion = (xcconfig: string, version: string) =>
  xcconfig.replace(/^(\s*MARKETING_VERSION\s*=\s*)\S+/m, `$1${version}`);

// App Store versions have zero or one dot, such as 1.0, and TestFlight
// versions two, such as 1.0.1. An App Store version's first TestFlight
// version adds .1: 1.0 becomes 1.0.1, and 2 becomes 2.0.1.
export function testflightVersion(version: string) {
  const parts = version.split(".");
  return parts.length === 3
    ? version
    : [...parts, "0"].slice(0, 2).concat("1").join(".");
}

export function nextPatch(version: string) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

const versionSubject = "🔧 chore(ios): Set the iPhone app version to ";

// A version change that the release pushes straight to main, under the shared
// release decision. Its trailers skip the production deployment, which the
// version file does not affect.
export const versionMessage = (version: string, why: string) =>
  [
    `${versionSubject}${version}`,
    why,
    [
      "Screenr-Deploy: skip",
      "Screenr-Deploy-Reason: Only the iPhone app's version file changed, and production does not read it.",
    ].join("\n"),
  ].join("\n\n");

// App Store Connect rejects What to Test text that contains emoji, so notes
// drop pictographs and the characters that join or modify them.
const emoji =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\u20e3\ufe0f]/gu;

export const cleanNotes = (text: string) =>
  text
    .replace(emoji, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function checkedNotes(notes: string, source: string) {
  if (!notes || notes.length > notesLimit)
    throw new Error(
      `${source} must have 1 to ${notesLimit} characters without emoji; ${notes.length ? `they have ${notes.length}` : "they are empty"}.`,
    );
  return notes;
}

// The tag message is the notes. Tags before 1.0.1 started with a
// "Screenr <version> (<build>)" line.
export const tagNotes = (message: string) =>
  message.replace(/^Screenr \S+ \(\d+\)\n\n/, "").trim();

export const notesPrompt = [
  'You write TestFlight "What to Test" notes for Screenr, an iPhone app for sharing TV shows and movies with friends.',
  "The input is the commit messages for app and server changes since the build testers already have.",
  "Write one or two short, casual sentences in plain everyday words that tell testers what changed that they might notice.",
  "Leave out code names, file and type names, issue or pull request numbers, and purely internal work such as logging, diagnostics, telemetry, tests, tooling, documentation, and refactors.",
  "Use no emoji or Markdown.",
  "If nothing would be noticeable, say the build has behind-the-scenes stability improvements.",
  "Reply with only the notes.",
].join(" ");
const unchanged = "Behind-the-scenes changes only; nothing new to test.";

export function processingTimeout(env: Environment) {
  const value = env[timeoutVariable] ?? String(defaultTimeoutSeconds);
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(
      `${timeoutVariable} must be a positive whole number of seconds.`,
    );
  return Number(value) * 1000;
}

type IO = {
  root: string;
  env: Environment;
  exec: Exec;
  fetch?: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
  // Asks a question in a terminal, or returns undefined without one.
  ask: (question: string) => Promise<string | undefined>;
};

async function capture(exec: Exec, command: string, args: readonly string[]) {
  const { status, stdout } = await exec(command, args);
  if (status)
    throw new Error(
      `${[command, ...args].join(" ")} failed with status ${status}.`,
    );
  return stdout.trim();
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

// The release gate from docs/development-workflow.md#ios-release-gate:
// bin/check-ios on the clean commit, on this Mac. It skips itself when the
// same iOS files passed with this Xcode in the last week, such as before the
// push that brought them to main.
export async function checkIos(
  exec: Exec,
  root: string,
  log: (line: string) => void,
) {
  log("==> Checking the iPhone app with bin/check-ios --reuse");
  const { status } = await exec(join(root, "bin/check-ios"), ["--reuse"], {
    output: "terminal",
  });
  if (status)
    throw new Error(
      `bin/check-ios failed with status ${status}. Fix the iOS checks on main before releasing.`,
    );
}

// The archive's last build phase uploads its symbols to Sentry, and a release
// archive fails without them, so a missing sentry-cli or token stops the
// release before it changes anything.
async function requireSentry(exec: Exec) {
  const info = await exec("sentry-cli", ["info", "--config-status-json"]).catch(
    (error) => {
      if (missing(error)) return undefined;
      throw error;
    },
  );
  if (!info)
    throw new Error(
      "sentry-cli is not installed, and a release must upload its symbols to Sentry. Install it with brew install getsentry/tools/sentry-cli.",
    );
  let auth: unknown;
  try {
    auth = (JSON.parse(info.stdout) as { auth?: { type?: unknown } }).auth
      ?.type;
  } catch {
    // Unreadable status; treated as no token.
  }
  if (info.status || !auth)
    throw new Error(
      "sentry-cli has no auth token, and a release must upload its symbols to Sentry. Set SENTRY_AUTH_TOKEN, or run sentry-cli login.",
    );
}

// Holds the release lock of every checkout of this clone, so two runs never
// pick the same build number. The lock file names the process that holds it;
// a file whose process has ended is left from a run that was killed.
async function lock(path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx" });
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = (await readFile(path, "utf8").catch(() => "")).trim();
      if (attempt || !/^\d+$/.test(holder) || running(Number(holder)))
        throw new Error(
          `Another bin/testflight${/^\d+$/.test(holder) ? `, process ${holder},` : ""} is releasing from this clone. Wait for it to finish; if none is running, remove ${path}.`,
        );
      await rm(path, { force: true });
    }
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Options = { distributeOnly: boolean; notes?: string };

export async function release(options: Options, io: IO) {
  const timeout = processingTimeout(io.env);
  const credentials = credentialsFrom(io.env);
  const given =
    options.notes === undefined
      ? undefined
      : checkedNotes(cleanNotes(options.notes), "--notes");
  const git = (...args: string[]) => capture(io.exec, "git", args);
  const unlock = await lock(
    join(
      await git("rev-parse", "--path-format=absolute", "--git-common-dir"),
      "screenr-testflight.lock",
    ),
  );
  try {
    await releaseLocked(options, given, timeout, credentials, io);
  } finally {
    await unlock();
  }
}

async function releaseLocked(
  options: Options,
  given: string | undefined,
  timeout: number,
  credentials: ReturnType<typeof credentialsFrom>,
  io: IO,
) {
  const { exec, root, log } = io;
  const git = (...args: string[]) => capture(exec, "git", args);
  const api = await appStoreConnect(credentials, io.fetch);
  await git("fetch", "--quiet", "origin", "main", "--tags");
  let tags = releaseTags((await git("tag", "--list", "ios-v*b*")).split("\n"));
  const app = await findApp(api, bundleId);
  const waiting = { sleep: io.sleep, log, timeout };
  const messageOf = async (tag: Tag) =>
    checkedNotes(
      cleanNotes(
        tagNotes(await git("tag", "--list", "--format=%(contents)", tag.name)),
      ),
      `The ${tag.name} tag's message`,
    );

  // Pushes the tag if origin lacks it, then brings its build to testers.
  // Returns false when Apple is reviewing an older build of its version.
  const distributeTag = async (tag: Tag, notes: string) => {
    try {
      const local = await git("rev-parse", `refs/tags/${tag.name}`);
      const remote = await git(
        "ls-remote",
        "--tags",
        "origin",
        `refs/tags/${tag.name}`,
      );
      if (remote.split(/\s/)[0] !== local) {
        log(`==> Pushing ${tag.name} to origin`);
        const pushed = await exec(
          "git",
          ["push", "origin", `refs/tags/${tag.name}`],
          { output: "terminal" },
        );
        if (pushed.status)
          throw new Error(`Could not push ${tag.name} to origin.`);
      }
      const result = await distribute(
        api,
        app,
        { version: tag.version, build: tag.build, notes },
        waiting,
      );
      if (result.nextVersion) return false;
      log(
        `==> Screenr ${tag.version} (${tag.build}) is in ${result.groups.join(", ")}; external testing: ${result.externalState}.`,
      );
      return true;
    } catch (error) {
      if (options.distributeOnly) throw error;
      throw new Error(
        `${(error as Error).message}\n${tag.name} is uploaded and tagged. Run bin/testflight --distribute-only to retry.`,
      );
    }
  };

  if (options.distributeOnly) {
    const latest = tags.at(-1);
    if (!latest) throw new Error("There is no ios-v*b* tag to distribute.");
    log(`==> Distributing ${latest.name}`);
    if (!(await distributeTag(latest, given ?? (await messageOf(latest)))))
      throw new Error(
        `Apple is reviewing an older build of ${latest.version}, so ${latest.name} cannot go to Beta App Review. Run bin/testflight without --distribute-only to release the next patch version.`,
      );
    return;
  }

  await requireSentry(exec);
  const changes = await git("status", "--porcelain", "--untracked-files=all");
  if (changes)
    throw new Error(`Commit or remove these changes first:\n${changes}`);
  const head = await git("rev-parse", "HEAD");
  const main = await git("rev-parse", "origin/main");
  // A version change that a failed check or push left unpushed resumes.
  const unpushed =
    head !== main &&
    (await git("rev-parse", "HEAD^")) === main &&
    (await git("diff", "--name-only", "HEAD^", "HEAD")) === versionFile &&
    (await git("log", "-1", "--format=%s", "HEAD")).startsWith(versionSubject);
  if (head !== main && !unpushed)
    throw new Error(
      `HEAD ${head.slice(0, 12)} is not origin/main ${main.slice(0, 12)}. Check out main and pull it first.`,
    );

  const versionPath = join(root, versionFile);
  const readVersion = async () =>
    marketingVersion(await readFile(versionPath, "utf8"));
  // Commits only the version file, checks the iOS files the pre-push hook
  // will require a pass for, and pushes the commit straight to main.
  const pushVersion = async () => {
    await checkIos(exec, root, log);
    log("==> Pushing the version change to main");
    const pushed = await exec(
      "git",
      ["push", "origin", "HEAD:refs/heads/main"],
      {
        output: "terminal",
      },
    );
    if (pushed.status)
      throw new Error(
        "Could not push the version change to main. It stays committed here; run bin/testflight again to push it, after rebasing it onto origin/main if main moved.",
      );
  };
  const changeVersion = async (version: string, why: string) => {
    log(`==> Changing the version to ${version}`);
    await writeFile(
      versionPath,
      withVersion(await readFile(versionPath, "utf8"), version),
    );
    await git(
      "commit",
      "--quiet",
      "--message",
      versionMessage(version, why),
      "--",
      versionFile,
    );
    await pushVersion();
  };
  // Apple reviews one build of a version at a time, so a release moves to the
  // next patch version when it would wait behind a review. It does so at most
  // once per run.
  let advanced = false;
  const advance = async (version: string) => {
    if (advanced)
      throw new Error(
        `Apple is also reviewing an older build of ${version}, which this run already moved to. Check TestFlight in App Store Connect, then run bin/testflight again.`,
      );
    advanced = true;
    const next = nextPatch(version);
    await changeVersion(
      next,
      `Apple was reviewing an older build of ${version}, so bin/testflight moved to ${next}.`,
    );
  };

  let notes: string;
  const released = releaseTags(
    (await git("tag", "--points-at", "HEAD", "--list", "ios-v*b*")).split("\n"),
  ).at(-1);
  if (released) {
    log(
      `==> This commit is already uploaded as ${released.name}; resuming its distribution`,
    );
    notes = given ?? (await messageOf(released));
    if (await distributeTag(released, notes)) return;
    await advance(released.version);
  } else {
    const version = await readVersion();
    notes =
      given ??
      (await draftNotes(await testedBuild(api, app.id), tags, head, io));
    if (unpushed) await pushVersion();
    const testflight = testflightVersion(version);
    if (testflight !== version)
      await changeVersion(
        testflight,
        `bin/testflight moved App Store version ${version} to its first TestFlight version, ${testflight}.`,
      );
  }

  for (;;) {
    const commit = await git("rev-parse", "HEAD");
    const version = await readVersion();
    const build = nextBuild(tags);
    const tag = { name: `ios-v${version}b${build}`, version, build };
    log(
      `==> Releasing Screenr ${version} (${build}) from ${commit.slice(0, 12)} as ${tag.name}`,
    );
    log(`What to Test:\n${notes}`);
    if (
      (await prepareReview(api, app.id, tag, { expireWaiting: false, log })) !==
      "ready"
    ) {
      await advance(version);
      continue;
    }
    await checkIos(exec, root, log);
    if (
      (await prepareReview(api, app.id, tag, { expireWaiting: true, log })) !==
      "ready"
    ) {
      await advance(version);
      continue;
    }
    await archiveAndUpload(tag, credentials, {
      ...io,
      // The archive takes a while; upload only the commit that was checked.
      verify: async () => {
        const current = await git("rev-parse", "HEAD");
        const changed = await git(
          "status",
          "--porcelain",
          "--untracked-files=all",
        );
        const problems = [
          ...(current === commit
            ? []
            : [
                `HEAD moved from ${commit.slice(0, 12)} to ${current.slice(0, 12)}`,
              ]),
          ...(changed ? [`these files changed:\n${changed}`] : []),
        ];
        if (problems.length)
          throw new Error(
            `The checkout changed while ${tag.name} was archiving, so nothing was uploaded: ${problems.join("; ")}`,
          );
      },
    });
    await git("tag", "--annotate", tag.name, "--message", notes, commit);
    tags = [...tags, tag];
    if (await distributeTag(tag, notes)) return;
    await advance(version);
  }
}

// What to Test for the changes since the build that the external group's
// testers have, drafted by llm and, in a terminal, confirmed or edited.
async function draftNotes(
  tested: number | undefined,
  tags: readonly Tag[],
  head: string,
  { exec, env, log, ask }: IO,
) {
  if (tested === undefined)
    throw new Error(
      `No build is in testing for "${externalGroupName}", so What to Test has no starting point. Pass --notes.`,
    );
  const matching = tags.filter(({ build }) => build === tested);
  if (matching.length !== 1)
    throw new Error(
      `Expected one ios-v*b${tested} tag for build ${tested}, the newest in testing for "${externalGroupName}", but found ${matching.length}. Fetch the tags with git fetch --tags, or pass --notes.`,
    );
  const base = matching[0]!.name;
  const ancestor = await exec("git", [
    "merge-base",
    "--is-ancestor",
    base,
    head,
  ]);
  if (ancestor.status)
    throw new Error(`${base} is not an ancestor of HEAD. Pass --notes.`);
  const messages = await capture(exec, "git", [
    "log",
    "--format=%B%x1e",
    `${base}..${head}`,
    "--",
    ...notePaths,
  ]);
  let notes = unchanged;
  if (messages) {
    const drafted = await exec("llm", ["-s", notesPrompt], {
      input: messages,
    }).catch((error) => {
      if (missing(error))
        throw new Error(
          "llm is not installed. Install it with pipx install llm, or pass --notes.",
        );
      throw error;
    });
    notes = cleanNotes(drafted.stdout);
    if (drafted.status || !notes)
      throw new Error("llm could not draft What to Test. Pass --notes.");
  }
  log(`==> What to Test for the changes since ${base}:\n\n${notes}\n`);
  for (;;) {
    const answer = await ask("Use these notes? [Y/e/n] ");
    const choice = answer?.trim().toLowerCase() ?? "y";
    if (["", "y", "yes"].includes(choice)) {
      if (notes.length <= notesLimit) return notes;
      if (answer === undefined)
        throw new Error(
          `The drafted notes have ${notes.length} characters, more than App Store Connect's ${notesLimit}. Edit them in a terminal, or pass --notes.`,
        );
      log(
        `Notes must have at most ${notesLimit} characters; edit them or stop.`,
      );
    } else if (["e", "edit"].includes(choice)) {
      notes = cleanNotes(await editNotes(notes, exec, env));
      if (!notes)
        throw new Error(
          "Stopped: the edited notes were empty. Run bin/testflight again, or pass --notes.",
        );
      log(`==> Edited What to Test:\n\n${notes}\n`);
    } else
      throw new Error(
        "Stopped without the drafted notes. Run bin/testflight again to draft new ones, or pass --notes.",
      );
  }
}

async function editNotes(notes: string, exec: Exec, env: Environment) {
  const directory = await mkdtemp(join(tmpdir(), "screenr-notes-"));
  try {
    const path = join(directory, "notes.txt");
    await writeFile(path, `${notes}\n`);
    const editor = env.VISUAL || env.EDITOR || "vi";
    const { status } = await exec("sh", ["-c", `${editor} "$1"`, "sh", path], {
      output: "terminal",
    });
    if (status)
      throw new Error(
        "The editor failed. Run bin/testflight again, or pass --notes.",
      );
    return await readFile(path, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function archiveAndUpload(
  tag: Tag,
  credentials: ReturnType<typeof credentialsFrom>,
  {
    exec,
    root,
    env,
    log,
    verify,
  }: {
    exec: Exec;
    root: string;
    env: Environment;
    log: (line: string) => void;
    verify: () => Promise<void>;
  },
) {
  const releases = join(root, "ios/build/release");
  const directory = join(releases, tag.name);
  const archive = join(directory, "Screenr.xcarchive");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  // A macOS SDKROOT from a shell profile would reach clang through xcodebuild.
  const { SDKROOT: _, ...base } = env;
  const signing = [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath",
    credentials.keyPath,
    "-authenticationKeyID",
    credentials.keyId,
    "-authenticationKeyIssuerID",
    credentials.issuerId,
  ];
  const xcodebuild = async (
    label: string,
    name: string,
    args: string[],
    environment: Environment,
    { packages = false } = {},
  ) => {
    const logPath = join(directory, `${name}.log`);
    log(`==> ${label}; the log is ${logPath}`);
    // bin/ios-packages resolves the packages into the Mac's shared cache and
    // holds it in use while xcodebuild builds against it.
    const options = ["-hideShellScriptEnvironment", ...args];
    const { status } = await exec(
      packages ? join(root, "bin/ios-packages") : "xcodebuild",
      packages ? ["xcodebuild", ...options] : options,
      {
        output: { log: logPath },
        env: environment,
      },
    );
    if (!status) return;
    const errors = (await readFile(logPath, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => /error:|\*\* .+ FAILED \*\*/.test(line))
      .slice(-20);
    throw new Error(
      [
        `${label} failed with status ${status}. See ${logPath}.`,
        ...errors,
      ].join("\n"),
    );
  };
  // SCREENR_REQUIRE_SENTRY_SYMBOLS makes bin/upload-ios-symbols, the
  // archive's last build phase, fail rather than skip without sentry-cli or
  // a token.
  await xcodebuild(
    "Archiving",
    "archive",
    [
      "archive",
      "-project",
      "ios/Screenr.xcodeproj",
      "-scheme",
      "Screenr",
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archive,
      "-derivedDataPath",
      join(directory, "DerivedData"),
      ...signing,
      `CURRENT_PROJECT_VERSION=${tag.build}`,
      "SCREENR_REQUIRE_SENTRY_SYMBOLS=YES",
    ],
    base,
    { packages: true },
  );
  await verify();
  // The upload's rsync starts its helper through PATH and needs Apple's, not
  // a newer one from Homebrew.
  await xcodebuild(
    "Uploading",
    "upload",
    [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportOptionsPlist",
      "ios/Config/ExportOptions.plist",
      "-exportPath",
      join(directory, "export"),
      ...signing,
    ],
    { ...base, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${base.PATH ?? ""}` },
  );
  await rm(join(directory, "DerivedData"), { recursive: true, force: true });
  await pruneReleases(releases, log);
}

// Removes the output of all but the newest releasesKept releases. The build
// is already uploaded, so a failure here only leaves more output behind.
async function pruneReleases(releases: string, log: (line: string) => void) {
  try {
    const old = releaseTags(await readdir(releases)).slice(0, -releasesKept);
    for (const { name } of old)
      await rm(join(releases, name), { recursive: true, force: true });
    if (old.length)
      log(
        `==> Removed the output of ${old.map(({ name }) => name).join(", ")}; ${releases} keeps the newest ${releasesKept} releases.`,
      );
  } catch (error) {
    log(
      `Could not remove older release output from ${releases}: ${(error as Error).message}`,
    );
  }
}

export type TesterOptions = { add: string[]; remove: string[]; list: boolean };

// The tester flags: friends test by email in the external group, which keeps
// every build after the App Store launch turns its public link off. They
// need only the API key, and take no release lock, since they never pick a
// build number.
export async function manageTesters(
  { add, remove, list }: TesterOptions,
  { env, fetch, log }: Pick<IO, "env" | "fetch" | "log">,
) {
  const api = await appStoreConnect(credentialsFrom(env), fetch);
  const app = (await findApp(api, bundleId)).id;
  for (const email of remove) await removeTester(api, app, email, log);
  for (const email of add) await addTester(api, app, email, log);
  if (!list) return;
  const testers = await groupTesters(api, app);
  if (!testers.length) {
    log(`==> "${externalGroupName}" has no testers.`);
    return;
  }
  log(
    `==> "${externalGroupName}" has ${testers.length} ${testers.length === 1 ? "tester" : "testers"}:`,
  );
  for (const { email, name, state, inviteType } of testers) {
    const who = email
      ? name
        ? `${name} <${email}>`
        : email
      : `${name || "No name"} (no email)`;
    const joined =
      inviteType === "PUBLIC_LINK"
        ? "joined through the public link"
        : "invited by email";
    log(`${who}: ${state ?? "no state"}, ${joined}`);
  }
}

const usage = `Usage: bin/testflight [--notes TEXT] [--distribute-only]
       bin/testflight [--add-tester EMAIL] [--remove-tester EMAIL] [--testers]
bin/shipit is the same command.

Releases the next TestFlight build of Screenr from a clean origin/main and
submits it for Beta App Review:

1. An App Store version, such as 1.0, first moves to its TestFlight version,
   1.0.1, in a commit pushed straight to main after bin/check-ios.
2. llm drafts What to Test from the changes since the build "Public testers"
   already has. In a terminal, use, edit, or stop.
3. bin/check-ios --reuse gates the release. An older build of the version
   still waiting for Beta App Review is expired; when Apple is already
   reviewing one, the release moves to the next patch version instead.
4. It archives, uploads, tags the commit ios-v<version>b<build> with the
   notes, waits for processing, and adds the build to "Public testers".

Running it again on a tagged commit resumes that build's distribution.

  --notes TEXT       Use TEXT as What to Test instead of drafting it.
  --distribute-only  Skip the build; retry the newest tag's processing wait,
                     notes, groups, and Beta App Review submission.

The tester flags change or list "Public testers" without a release, and may
repeat:

  --add-tester EMAIL     Add EMAIL to "Public testers"; TestFlight emails
                         them an invitation.
  --remove-tester EMAIL  Take EMAIL out of "Public testers".
  --testers              List the testers in "Public testers".

Adding someone already in the group, or removing someone who isn't, changes
nothing.

Needs ASC_KEY_PATH, ASC_KEY_ID, and ASC_ISSUER_ID for the App Store Connect
API key. A release also needs sentry-cli with an auth token, llm unless
--notes is given, and Git access to push to origin.
${timeoutVariable} sets the processing wait in seconds; the default
is ${defaultTimeoutSeconds}.`;

export type Command =
  | { kind: "help" }
  | { kind: "release"; options: Options }
  | { kind: "testers"; options: TesterOptions };

export function parseCommand(args: string[]): Command {
  const { values } = parseArgs({
    args,
    options: {
      "distribute-only": { type: "boolean", default: false },
      notes: { type: "string" },
      "add-tester": { type: "string", multiple: true, default: [] },
      "remove-tester": { type: "string", multiple: true, default: [] },
      testers: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { kind: "help" };
  // Apple matches tester emails without regard to case.
  const emails = (flag: "add-tester" | "remove-tester") => [
    ...new Set(
      values[flag].map((value) => {
        const email = value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new Error(
            `--${flag} needs an email address, such as friend@example.com, not "${value}".`,
          );
        return email;
      }),
    ),
  ];
  const add = emails("add-tester");
  const remove = emails("remove-tester");
  if (!add.length && !remove.length && !values.testers)
    return {
      kind: "release",
      options: {
        distributeOnly: values["distribute-only"],
        notes: values.notes,
      },
    };
  if (values.notes !== undefined || values["distribute-only"])
    throw new Error(
      "--add-tester, --remove-tester, and --testers change or list testers without a release; leave out --notes and --distribute-only.",
    );
  const both = add.find((email) => remove.includes(email));
  if (both)
    throw new Error(`Both --add-tester and --remove-tester name ${both}.`);
  return { kind: "testers", options: { add, remove, list: values.testers } };
}

if (process.argv[1]?.endsWith("scripts/testflight.ts")) {
  try {
    const command = parseCommand(process.argv.slice(2));
    const log = (line: string) => console.log(line);
    if (command.kind === "help") console.log(usage);
    else if (command.kind === "testers")
      await manageTesters(command.options, { env: process.env, log });
    else {
      const root = fileURLToPath(new URL("..", import.meta.url));
      await release(command.options, {
        root,
        env: process.env,
        exec: commands(root),
        sleep: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
        log,
        ask: async (question) => {
          if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            return await prompt.question(question);
          } finally {
            prompt.close();
          }
        },
      });
    }
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
