import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  marketingVersion,
  nextBuild,
  release,
  releaseTags,
  testerNotes,
  type Exec,
} from "../../scripts/ios-testflight";
import type { Environment } from "../../scripts/app-store-connect";

const head = "c".repeat(40);
const older = "b".repeat(40);

type Call = {
  command: string;
  args: string[];
  output: unknown;
  env?: Environment;
};
type Answer = { status?: number; stdout?: string };

// A fake shell that answers each command line from the first matching rule
// and records every call. Unanswered commands fail the test.
function fakeShell(rules: [RegExp, Answer | ((call: Call) => Answer)][]) {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options = {}) => {
    const call = {
      command,
      args: [...args],
      output: options.output ?? "capture",
      env: options.env,
    };
    calls.push(call);
    const line = [command, ...args].join(" ");
    const rule = rules.find(([pattern]) => pattern.test(line));
    if (!rule) throw new Error(`Unexpected command: ${line}`);
    const answer = typeof rule[1] === "function" ? rule[1](call) : rule[1];
    return { status: answer.status ?? 0, stdout: answer.stdout ?? "" };
  };
  const lines = () =>
    calls.map(({ command, args }) => [command, ...args].join(" "));
  return { exec, calls, lines };
}

const quiet = { sleep: async () => {}, log: () => {} };

test("build numbers follow the highest ios-v*b* tag", () => {
  assert.deepEqual(nextBuild(releaseTags([""])), 1);
  const tags = releaseTags([
    "ios-v1.0b2",
    "ios-v1.1b10",
    "ios-v1.0b9",
    "v2.0b40",
    "ios-v1.0b0",
    "ios-v1.0bx",
    "ios-v1.0.1b3",
  ]);
  assert.deepEqual(
    tags.map(({ name }) => name),
    ["ios-v1.0b2", "ios-v1.0.1b3", "ios-v1.0b9", "ios-v1.1b10"],
  );
  assert.deepEqual(tags.at(-1), {
    name: "ios-v1.1b10",
    version: "1.1",
    build: 10,
  });
  assert.equal(nextBuild(tags), 11);
});

test("the marketing version comes from Version.xcconfig", () => {
  assert.equal(
    marketingVersion(
      "// The app's marketing version.\nMARKETING_VERSION = 1.2.3\n",
    ),
    "1.2.3",
  );
  assert.throws(() => marketingVersion("MARKETING_VERSION = $(OTHER)\n"), {
    message:
      "ios/Config/Version.xcconfig must set MARKETING_VERSION to a number such as 1.0.",
  });
});

test("What to Test lists the app and server API changes testers can see", () => {
  assert.equal(
    testerNotes(
      [
        "✨ feat(ios): Add the You tab (#301)",
        "🐛 fix(server): Keep spoilers out of push alerts (#302)",
        "⚡ perf: Load the feed faster",
        "♻️ refactor(server): Split the feed queries (#303)",
        "📝 docs: Describe the You tab",
        "✅ test(ios): Cover the You tab",
        "🔧 ci(ios): Cache the Simulator runtime",
        'Revert "Add the You tab"',
        "✨ feat(ios): Add the You tab (#301)",
      ],
      "ios-v1.0b3",
    ),
    [
      "- Add the You tab",
      "- Keep spoilers out of push alerts",
      "- Load the feed faster",
      '- Revert "Add the You tab"',
    ].join("\n"),
  );
  assert.equal(
    testerNotes(["🔧 chore: Update dependencies"], "ios-v1.0b3"),
    "Behind-the-scenes changes only; nothing new to test.",
  );
  assert.equal(
    testerNotes(["✨ feat(ios): Add the You tab"], undefined),
    "The first TestFlight build of Screenr for iPhone.",
  );
  // App Store Connect accepts at most 4,000 characters.
  const many = Array.from(
    { length: 200 },
    (_, index) => `✨ feat: Change number ${index} ${"x".repeat(30)}`,
  );
  const notes = testerNotes(many, "ios-v1.0b3");
  assert.ok(notes.length <= 4000);
  assert.match(notes, /^- Change number 0 x+\n/);
  const shown = notes.split("\n").length - 1;
  assert.match(notes, new RegExp(`\\n- And ${200 - shown} more changes\\.$`));
});

// A checkout with Version.xcconfig and an API key, a clean main at c, and
// tags through build 3 on commit b. Rules added first override the defaults.
async function releaseFixture(
  overrides: [RegExp, Answer | ((call: Call) => Answer)][] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "screenr-release-"));
  await mkdir(join(root, "ios/Config"), { recursive: true });
  await writeFile(
    join(root, "ios/Config/Version.xcconfig"),
    "MARKETING_VERSION = 1.0\n",
  );
  const keyPath = join(root, "AuthKey.p8");
  await writeFile(
    keyPath,
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );
  const shell = fakeShell([
    ...overrides,
    [/^git fetch --quiet origin main --tags$/, {}],
    [/^git status --porcelain --untracked-files=all$/, {}],
    [/^git rev-parse (HEAD|origin\/main)$/, { stdout: `${head}\n` }],
    [
      /^git tag --list ios-v\*b\*$/,
      { stdout: "ios-v1.0b1\nios-v1.0b3\nios-v1.0b2\n" },
    ],
    [/^git tag --points-at HEAD --list ios-v\*b\*$/, {}],
    [
      /^git log --format=%s ios-v1\.0b3\.\.c{40} -- ios src\/server src\/app\/api$/,
      { stdout: "✨ feat(ios): Add the You tab (#301)\n" },
    ],
    [/\/bin\/check-ios --reuse$/, {}],
    [/^xcodebuild /, {}],
    [/^git tag --annotate /, {}],
    [/^git push origin refs\/tags\/ios-v1\.0b4$/, {}],
  ]);
  const requests: string[] = [];
  // App Store Connect has no app here, so distribution stops at its lookup.
  const fetch = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input)).pathname);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  const io = {
    root,
    env: {
      ASC_KEY_PATH: keyPath,
      ASC_KEY_ID: "KEY1234567",
      ASC_ISSUER_ID: "issuer",
      PATH: "/opt/homebrew/bin",
      SDKROOT: "macosx",
    },
    exec: shell.exec,
    fetch,
    ...quiet,
  };
  const cleanup = () => rm(root, { recursive: true, force: true });
  return { root, keyPath, shell, io, requests, cleanup };
}

test("a release archives and uploads the next build, then tags and pushes the commit", async () => {
  const fixture = await releaseFixture();
  try {
    await assert.rejects(
      release({ distributeOnly: false, submitReview: false }, fixture.io),
      {
        message:
          /No App Store Connect app has the bundle ID com\.artisanalsoftware\.Screenr\.\nios-v1\.0b4 is uploaded and tagged\. Run bin\/ios-testflight --distribute-only to retry\./,
      },
    );
    // The gate runs bin/check-ios in the terminal before anything is built.
    const gate = fixture.shell.calls.findIndex(
      ({ command }) => command === join(fixture.root, "bin/check-ios"),
    );
    assert.deepEqual(fixture.shell.calls[gate]?.args, ["--reuse"]);
    assert.equal(fixture.shell.calls[gate]?.output, "terminal");
    assert.ok(
      gate <
        fixture.shell.calls.findIndex(
          ({ command }) => command === "xcodebuild",
        ),
    );
    const [archive, upload] = fixture.shell.calls.filter(
      ({ command }) => command === "xcodebuild",
    );
    const directory = join(fixture.root, "ios/build/release/ios-v1.0b4");
    const authentication = [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      fixture.keyPath,
      "-authenticationKeyID",
      "KEY1234567",
      "-authenticationKeyIssuerID",
      "issuer",
    ];
    assert.deepEqual(archive?.args, [
      "-hideShellScriptEnvironment",
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
      join(directory, "Screenr.xcarchive"),
      "-derivedDataPath",
      join(directory, "DerivedData"),
      ...authentication,
      "CURRENT_PROJECT_VERSION=4",
    ]);
    assert.deepEqual(archive?.output, { log: join(directory, "archive.log") });
    assert.equal(archive?.env?.SDKROOT, undefined);
    assert.deepEqual(upload?.args, [
      "-hideShellScriptEnvironment",
      "-exportArchive",
      "-archivePath",
      join(directory, "Screenr.xcarchive"),
      "-exportOptionsPlist",
      "ios/Config/ExportOptions.plist",
      "-exportPath",
      join(directory, "export"),
      ...authentication,
    ]);
    assert.match(upload?.env?.PATH ?? "", /^\/usr\/bin:/);
    const tag = fixture.shell.calls.find(
      ({ args }) => args[0] === "tag" && args[1] === "--annotate",
    );
    assert.deepEqual(tag?.args, [
      "tag",
      "--annotate",
      "ios-v1.0b4",
      "--message",
      "Screenr 1.0 (4)\n\n- Add the You tab",
      head,
    ]);
    assert.ok(
      fixture.shell.lines().includes("git push origin refs/tags/ios-v1.0b4"),
    );
    assert.deepEqual(fixture.requests, ["/v1/apps"]);
  } finally {
    await fixture.cleanup();
  }
});

test("a release stops before distribution when GitHub refuses the tag", async () => {
  const fixture = await releaseFixture([
    [/^git push origin refs\/tags\/ios-v1\.0b4$/, { status: 1 }],
  ]);
  try {
    await assert.rejects(
      release({ distributeOnly: false, submitReview: false }, fixture.io),
      {
        message:
          /^ios-v1\.0b4 is uploaded but could not be pushed\. Run git push origin refs\/tags\/ios-v1\.0b4, then bin\/ios-testflight --distribute-only\.$/,
      },
    );
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.cleanup();
  }
});

test("a release refuses a dirty, stale, released, or failing checkout and tags nothing after a failed upload", async () => {
  const cases: [string, [RegExp, Answer][], RegExp][] = [
    [
      "dirty",
      [[/^git status/, { stdout: "?? notes.txt\n" }]],
      /Commit or remove these changes first:\n\?\? notes\.txt/,
    ],
    [
      "stale",
      [[/^git rev-parse origin\/main$/, { stdout: `${older}\n` }]],
      /HEAD cccccccccccc is not origin\/main bbbbbbbbbbbb/,
    ],
    [
      "released",
      [[/^git tag --points-at HEAD/, { stdout: "ios-v1.0b3\n" }]],
      /already released as ios-v1\.0b3\. Run bin\/ios-testflight --distribute-only/,
    ],
    [
      "iOS checks",
      [[/\/bin\/check-ios --reuse$/, { status: 1 }]],
      /^bin\/check-ios failed with status 1\. Fix the iOS checks on main before releasing\.$/,
    ],
    [
      "upload",
      [[/^xcodebuild .*-exportArchive/, { status: 70 }]],
      /Uploading failed with status 70\. See .*upload\.log/,
    ],
  ];
  for (const [name, overrides, message] of cases) {
    const fixture = await releaseFixture(overrides);
    try {
      await assert.rejects(
        release({ distributeOnly: false, submitReview: false }, fixture.io),
        { message },
      );
      if (name !== "upload")
        assert.ok(
          !fixture.shell.calls.some((call) => call.command === "xcodebuild"),
        );
      assert.ok(
        !fixture.shell
          .lines()
          .some((line) => /^git (tag --annotate|push)/.test(line)),
      );
      assert.deepEqual(fixture.requests, []);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("--distribute-only retries the newest tag's build without building", async () => {
  const fixture = await releaseFixture([
    [
      /^git log --format=%s ios-v1\.0b2\.\.ios-v1\.0b3 -- /,
      { stdout: "🐛 fix: Keep the badge in sync\n" },
    ],
  ]);
  try {
    await assert.rejects(
      release({ distributeOnly: true, submitReview: false }, fixture.io),
      {
        message:
          /^No App Store Connect app has the bundle ID com\.artisanalsoftware\.Screenr\.$/,
      },
    );
    assert.ok(
      !fixture.shell
        .lines()
        .some((line) =>
          /^(xcodebuild|\S+\/bin\/check-ios|git (status|tag --annotate|push))/.test(
            line,
          ),
        ),
    );
    // Its notes cover the commits between the previous tag and this one.
    assert.ok(
      fixture.shell
        .lines()
        .includes(
          "git log --format=%s ios-v1.0b2..ios-v1.0b3 -- ios src/server src/app/api",
        ),
    );
    assert.deepEqual(fixture.requests, ["/v1/apps"]);
  } finally {
    await fixture.cleanup();
  }
});
