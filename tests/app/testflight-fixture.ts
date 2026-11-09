import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../../scripts/app-store-connect";
import {
  marketingVersion,
  release,
  releaseTags,
  type Exec,
  type Options,
} from "../../scripts/testflight";
import {
  fakeConnect,
  internalTeam,
  publicTesters,
  type FakeOptions,
} from "./app-store-connect-fixture";

// A fake checkout, shell, and App Store Connect for bin/testflight's tests in
// testflight.test.ts. The shell answers Git, llm, sentry-cli, bin/check-ios,
// bin/ios-packages, and xcodebuild from rules and keeps the checkout's state.

export const head = "c".repeat(40);
export const older = "b".repeat(40);
export const drafted = "You can now find friends' picks in the new You tab.";

export type Call = {
  command: string;
  args: string[];
  output: unknown;
  env?: Environment;
  input?: string;
};
export type Answer = { status?: number; stdout?: string };
export type Rule = [RegExp, Answer | ((call: Call) => Answer)];

// A fake shell that answers each command line from the first matching rule
// and records every call. Unanswered commands fail the test.
function fakeShell(rules: Rule[], events: string[]) {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options = {}) => {
    const call = {
      command,
      args: [...args],
      output: options.output ?? "capture",
      env: options.env,
      input: options.input,
    };
    calls.push(call);
    const line = [command, ...args].join(" ");
    events.push(line);
    const rule = rules.find(([pattern]) => pattern.test(line));
    if (!rule) throw new Error(`Unexpected command: ${line}`);
    const answer = typeof rule[1] === "function" ? rule[1](call) : rule[1];
    return { status: answer.status ?? 0, stdout: answer.stdout ?? "" };
  };
  const lines = () =>
    calls.map(({ command, args }) => [command, ...args].join(" "));
  return { exec, calls, lines };
}

export type Fixture = Awaited<ReturnType<typeof releaseFixture>>;

// A checkout at version 1.0.1 with an API key and a clean main at c, whose
// tags ios-v1.0b1, ios-v1.0b2, and ios-v1.0.1b3 are on commit b and on
// origin. In App Store Connect, builds 2 and 3 are in testing for "Public
// testers". Rules added first override the defaults, and connect.builds
// replaces the default builds.
export async function releaseFixture(
  options: {
    version?: string;
    rules?: Rule[];
    connect?: FakeOptions;
    ask?: (string | undefined)[];
    env?: Environment;
    // Runs when the fake xcodebuild uploads a build.
    onUpload?: (build: number) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "screenr-release-"));
  const gitDir = join(root, ".git");
  await mkdir(gitDir);
  await mkdir(join(root, "ios/Config"), { recursive: true });
  const versionPath = join(root, "ios/Config/Version.xcconfig");
  await writeFile(
    versionPath,
    `// The app's marketing version.\nMARKETING_VERSION = ${options.version ?? "1.0.1"}\n`,
  );
  const keyPath = join(root, "AuthKey.p8");
  await writeFile(
    keyPath,
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );
  const events: string[] = [];
  const connect = fakeConnect({
    groups: [internalTeam, publicTesters],
    members: { "group-public": [2, 3] },
    ...options.connect,
    builds: options.connect?.builds ?? [
      { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
      { version: "1.0.1", build: 3, externalState: "IN_BETA_TESTING" },
    ],
  });
  const fetch = (async (input, init) => {
    events.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return connect.fetch(input, init);
  }) as typeof globalThis.fetch;
  const names = ["ios-v1.0b1", "ios-v1.0b2", "ios-v1.0.1b3"];
  const git = {
    head,
    main: head,
    parent: older,
    status: "",
    tags: new Map(
      names.map((name) => [
        name,
        { commit: older, message: `Older notes for ${name}` },
      ]),
    ),
    remote: new Set(names),
    commits: [] as { sha: string; message: string; version: string }[],
  };
  const shas = ["d", "e", "f"].map((letter) => letter.repeat(40));
  const named = (call: Call) => call.args.at(-1)!.replace(/^refs\/tags\//, "");
  const shell = fakeShell(
    [
      ...(options.rules ?? []),
      [
        /^git rev-parse --path-format=absolute --git-common-dir$/,
        { stdout: `${gitDir}\n` },
      ],
      [/^git fetch --quiet origin main --tags$/, {}],
      [
        /^git tag --list ios-v\*b\*$/,
        () => ({ stdout: [...git.tags.keys()].join("\n") }),
      ],
      [
        /^git status --porcelain --untracked-files=all$/,
        () => ({ stdout: git.status }),
      ],
      [/^git rev-parse HEAD$/, () => ({ stdout: `${git.head}\n` })],
      [/^git rev-parse origin\/main$/, () => ({ stdout: `${git.main}\n` })],
      [/^git rev-parse HEAD\^$/, () => ({ stdout: `${git.parent}\n` })],
      [
        /^git tag --points-at HEAD --list ios-v\*b\*$/,
        () => ({
          stdout: [...git.tags]
            .filter(([, { commit }]) => commit === git.head)
            .map(([name]) => name)
            .join("\n"),
        }),
      ],
      [/^git merge-base --is-ancestor ios-v\S+ \w{40}$/, {}],
      [
        /^git log --format=%B%x1e ios-v[\d.]+b\d\.\.\w{40} -- ios src\/server src\/app\/api :\(exclude\)ios\/Config\/Version\.xcconfig :\(exclude,glob\)ios\/\*\.md$/,
        {
          stdout:
            "✨ feat(ios): Add the You tab (#301)\n\nTesters asked for it.\n\x1e\n🐛 fix(server): Keep spoilers out of push alerts (#302)\n\x1e\n",
        },
      ],
      [/^llm -s /, { stdout: `${drafted} 🎉\n` }],
      [
        /^sentry-cli info --config-status-json$/,
        { stdout: JSON.stringify({ auth: { type: "token" } }) },
      ],
      [/\/bin\/check-ios --reuse$/, {}],
      [/\/bin\/ios-packages xcodebuild /, {}],
      [
        /^xcodebuild .*-exportArchive/,
        ({ args }) => {
          const archive = args[args.indexOf("-archivePath") + 1]!;
          const [tag] = releaseTags([archive.split("/").at(-2)!]);
          connect.upload(tag!.version, tag!.build);
          options.onUpload?.(tag!.build);
          return {};
        },
      ],
      [
        /^git tag --annotate /,
        ({ args }) => {
          git.tags.set(args[2]!, { commit: args[5]!, message: args[4]! });
          return {};
        },
      ],
      [
        /^git tag --list --format=%\(contents\) /,
        (call) => ({ stdout: `${git.tags.get(named(call))?.message}\n` }),
      ],
      [
        /^git rev-parse refs\/tags\//,
        (call) => ({ stdout: `object-${named(call)}\n` }),
      ],
      [
        /^git ls-remote --tags origin /,
        (call) => ({
          stdout: git.remote.has(named(call))
            ? `object-${named(call)}\trefs/tags/${named(call)}\n`
            : "",
        }),
      ],
      [
        /^git push origin refs\/tags\//,
        (call) => {
          git.remote.add(named(call));
          return {};
        },
      ],
      [
        /^git commit --quiet --message /,
        ({ args }) => {
          const sha = shas.shift()!;
          git.commits.push({
            sha,
            message: args[3]!,
            version: marketingVersion(readFileSync(versionPath, "utf8")),
          });
          git.parent = git.head;
          git.head = sha;
          return {};
        },
      ],
      [
        /^git push origin HEAD:refs\/heads\/main$/,
        () => {
          git.main = git.head;
          return {};
        },
      ],
      [
        /^git diff --name-only HEAD\^ HEAD$/,
        { stdout: "ios/Config/Version.xcconfig\n" },
      ],
      [
        /^git log -1 --format=%s HEAD$/,
        () => ({
          stdout: `${git.commits.at(-1)?.message.split("\n")[0] ?? "✨ feat(ios): Add the You tab"}\n`,
        }),
      ],
    ],
    events,
  );
  const lines: string[] = [];
  const answers = [...(options.ask ?? [])];
  const questions: string[] = [];
  const io = {
    root,
    env: {
      ASC_KEY_PATH: keyPath,
      ASC_KEY_ID: "KEY1234567",
      ASC_ISSUER_ID: "issuer",
      PATH: "/opt/homebrew/bin",
      SDKROOT: "macosx",
      ...options.env,
    },
    exec: shell.exec,
    fetch,
    sleep: async () => {},
    log: (line: string) => void lines.push(line),
    ask: async (question: string) => {
      questions.push(question);
      return answers.shift();
    },
  };
  const run = (overrides: Partial<Options> = {}) =>
    release({ distributeOnly: false, ...overrides }, io);
  // Where in the run the first event matching a pattern happened.
  const at = (pattern: RegExp) => {
    const index = events.findIndex((event) => pattern.test(event));
    assert.ok(index >= 0, `No event matches ${pattern}`);
    return index;
  };
  const ran = (pattern: RegExp) => events.some((event) => pattern.test(event));
  const cleanup = () => rm(root, { recursive: true, force: true });
  return {
    root,
    gitDir,
    lockPath: join(gitDir, "screenr-testflight.lock"),
    versionPath,
    keyPath,
    shell,
    connect,
    git,
    io,
    lines,
    questions,
    events,
    run,
    at,
    ran,
    cleanup,
  };
}

export async function withFixture(
  options: Parameters<typeof releaseFixture>[0],
  check: (fixture: Fixture) => Promise<void>,
) {
  const fixture = await releaseFixture(options);
  try {
    await check(fixture);
  } finally {
    await fixture.cleanup();
  }
}
