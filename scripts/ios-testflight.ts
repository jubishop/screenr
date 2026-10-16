import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  appStoreConnect,
  credentialsFrom,
  distribute,
  type Environment,
} from "./app-store-connect";

// bin/ios-testflight: release the iPhone app to TestFlight from the owner's
// Mac. It requires a clean origin/main that passes bin/check-ios, archives
// and uploads the Release app with xcodebuild, tags the commit
// ios-v<version>b<build>, and then brings the build to testers through the
// App Store Connect API. See docs/development-workflow.md#testflight-releases.

const bundleId = "com.artisanalsoftware.Screenr";
// Commits under these paths can change what testers see: the app and the
// server API it calls.
const notePaths = ["ios", "src/server", "src/app/api"];
const tagPattern = /^ios-v(\d+(?:\.\d+){0,2})b([1-9]\d*)$/;
// App Store Connect accepts What to Test notes of up to 4,000 characters.
const notesLimit = 4000;

export type Output = "capture" | "terminal" | { log: string };
export type Exec = (
  command: string,
  args: readonly string[],
  options?: { output?: Output; env?: Environment },
) => Promise<{ status: number; stdout: string }>;

// Runs a command in the checkout. "capture" returns standard output and
// passes errors to the terminal; a log receives both streams.
export function commands(cwd: string): Exec {
  return (command, args, { output = "capture", env = process.env } = {}) =>
    new Promise((resolve, reject) => {
      const log =
        typeof output === "object" ? createWriteStream(output.log) : undefined;
      const child = spawn(command, args, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio:
          output === "terminal"
            ? "inherit"
            : ["ignore", "pipe", log ? "pipe" : "inherit"],
      });
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
      "ios/Config/Version.xcconfig must set MARKETING_VERSION to a number such as 1.0.",
    );
  return version;
}

// Commit subjects follow "<emoji> <type>(<scope>): <summary> (#<PR>)". Testers
// see the summaries of features, fixes, and performance work, plus any
// subject without a type, such as a revert.
const conventional =
  /^(?:\S+\s+)?(feat|fix|perf|refactor|docs|test|build|ci|chore|style)(?:\([^)]*\))?!?:\s*(.+)$/u;
const forTesters = new Set(["feat", "fix", "perf"]);

export function testerNotes(
  subjects: readonly string[],
  previous: string | undefined,
) {
  if (!previous) return "The first TestFlight build of Screenr for iPhone.";
  const lines = new Set<string>();
  for (const subject of subjects) {
    const match = subject.trim().match(conventional);
    if (match && !forTesters.has(match[1]!)) continue;
    const summary = (match ? match[2]! : subject.trim()).replace(
      /\s+\(#\d+\)$/,
      "",
    );
    if (summary) lines.add(`- ${summary}`);
  }
  if (!lines.size)
    return "Behind-the-scenes changes only; nothing new to test.";
  const all = [...lines];
  for (let shown = all.length; ; shown--) {
    const rest = all.length - shown;
    const notes = [
      ...all.slice(0, shown),
      ...(rest ? [`- And ${rest} more changes.`] : []),
    ].join("\n");
    if (notes.length <= notesLimit) return notes;
  }
}

type IO = {
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
};

async function capture(exec: Exec, command: string, args: readonly string[]) {
  const { status, stdout } = await exec(command, args);
  if (status)
    throw new Error(
      `${[command, ...args].join(" ")} failed with status ${status}.`,
    );
  return stdout.trim();
}

// The release gate from docs/development-workflow.md#ios-release-gate:
// bin/check-ios on the clean main commit, on this Mac. It skips itself when
// the same iOS files passed with this Xcode in the last week, such as before
// the push that brought them to main.
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

export type Options = { distributeOnly: boolean; submitReview: boolean };

export async function release(
  options: Options,
  io: IO & {
    root: string;
    env: Environment;
    exec: Exec;
    fetch?: typeof fetch;
  },
) {
  const { exec, root, log } = io;
  const credentials = credentialsFrom(io.env);
  const api = await appStoreConnect(credentials, io.fetch);
  const git = (...args: string[]) => capture(exec, "git", args);
  await git("fetch", "--quiet", "origin", "main", "--tags");
  const tags = releaseTags(
    (await git("tag", "--list", "ios-v*b*")).split("\n"),
  );
  const notesFor = async (previous: Tag | undefined, revision: string) =>
    testerNotes(
      previous
        ? (
            await git(
              "log",
              "--format=%s",
              `${previous.name}..${revision}`,
              "--",
              ...notePaths,
            )
          ).split("\n")
        : [],
      previous?.name,
    );

  let tag: Tag;
  let notes: string;
  if (options.distributeOnly) {
    const latest = tags.at(-1);
    if (!latest) throw new Error("There is no ios-v*b* tag to distribute.");
    tag = latest;
    notes = await notesFor(tags.at(-2), tag.name);
  } else {
    const changes = await git("status", "--porcelain", "--untracked-files=all");
    if (changes)
      throw new Error(`Commit or remove these changes first:\n${changes}`);
    const head = await git("rev-parse", "HEAD");
    const main = await git("rev-parse", "origin/main");
    if (head !== main)
      throw new Error(
        `HEAD ${head.slice(0, 12)} is not origin/main ${main.slice(0, 12)}. Check out main and pull it first.`,
      );
    const released = await git(
      "tag",
      "--points-at",
      "HEAD",
      "--list",
      "ios-v*b*",
    );
    if (released)
      throw new Error(
        `This commit is already released as ${released.split("\n").join(", ")}. Run bin/ios-testflight --distribute-only to retry its distribution.`,
      );
    const version = marketingVersion(
      await readFile(join(root, "ios/Config/Version.xcconfig"), "utf8"),
    );
    const build = nextBuild(tags);
    tag = { name: `ios-v${version}b${build}`, version, build };
    notes = await notesFor(tags.at(-1), head);
    log(
      `==> Releasing Screenr ${version} (${build}) from ${head.slice(0, 12)} as ${tag.name}`,
    );
    log(`What to Test:\n${notes}`);
    await checkIos(exec, root, log);
    await archiveAndUpload(tag, credentials, io);
    await git(
      "tag",
      "--annotate",
      tag.name,
      "--message",
      `Screenr ${version} (${build})\n\n${notes}`,
      head,
    );
    await pushTag(exec, tag.name);
  }

  try {
    const result = await distribute(
      api,
      {
        bundleId,
        version: tag.version,
        build: tag.build,
        notes,
        submitReview: options.submitReview,
      },
      io,
    );
    log(
      `==> Screenr ${tag.version} (${tag.build}) is in ${result.groups.join(", ")}; external testing: ${result.externalState}.`,
    );
  } catch (error) {
    if (options.distributeOnly) throw error;
    throw new Error(
      `${(error as Error).message}\n${tag.name} is uploaded and tagged. Run bin/ios-testflight --distribute-only to retry.`,
    );
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
  }: {
    exec: Exec;
    root: string;
    env: Environment;
    log: (line: string) => void;
  },
) {
  const directory = join(root, "ios/build/release", tag.name);
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
  ) => {
    const logPath = join(directory, `${name}.log`);
    log(`==> ${label}; the log is ${logPath}`);
    const { status } = await exec(
      "xcodebuild",
      ["-hideShellScriptEnvironment", ...args],
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
    ],
    base,
  );
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
}

async function pushTag(exec: Exec, name: string) {
  const pushed = await exec("git", ["push", "origin", `refs/tags/${name}`], {
    output: "terminal",
  });
  if (pushed.status)
    throw new Error(
      `${name} is uploaded but could not be pushed. Run git push origin refs/tags/${name}, then bin/ios-testflight --distribute-only.`,
    );
}

const usage = `Usage: bin/ios-testflight [--distribute-only] [--submit-review]

Runs bin/check-ios --reuse on a clean origin/main, archives and uploads the
next TestFlight build of Screenr, tags the commit ios-v<version>b<build>,
waits for App Store Connect to process the build, sets What to Test from the
commits since the previous tag, and adds the build to the "Public testers"
group.

  --distribute-only  Skip the build; retry the newest tag's processing wait,
                     notes, and groups.
  --submit-review    Also submit the build for Beta App Review.

Needs ASC_KEY_PATH, ASC_KEY_ID, and ASC_ISSUER_ID for the App Store Connect
API key, and Git access to push tags to origin.`;

if (process.argv[1]?.endsWith("scripts/ios-testflight.ts")) {
  try {
    const { values } = parseArgs({
      options: {
        "distribute-only": { type: "boolean", default: false },
        "submit-review": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) console.log(usage);
    else {
      const root = fileURLToPath(new URL("..", import.meta.url));
      await release(
        {
          distributeOnly: values["distribute-only"],
          submitReview: values["submit-review"],
        },
        {
          root,
          env: process.env,
          exec: commands(root),
          sleep: (milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)),
          log: (line) => console.log(line),
        },
      );
    }
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
