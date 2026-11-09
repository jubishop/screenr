import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanNotes,
  marketingVersion,
  nextBuild,
  nextPatch,
  notesPrompt,
  processingTimeout,
  releaseTags,
  tagNotes,
  testflightVersion,
  versionMessage,
  withVersion,
} from "../../scripts/testflight";
import {
  drafted,
  head,
  older,
  withFixture,
  type Call,
  type Fixture,
  type Rule,
} from "./testflight-fixture";

const building = /xcodebuild|\/bin\/check-ios/;

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

test("App Store versions move to TestFlight versions in a commit that skips deployment", () => {
  const xcconfig = "// The app's marketing version.\nMARKETING_VERSION = 1.0\n";
  assert.equal(marketingVersion(xcconfig), "1.0");
  assert.throws(() => marketingVersion("MARKETING_VERSION = $(OTHER)\n"), {
    message:
      "ios/Config/Version.xcconfig must set MARKETING_VERSION to a number such as 1.0.",
  });
  assert.equal(
    withVersion(xcconfig, "1.0.1"),
    "// The app's marketing version.\nMARKETING_VERSION = 1.0.1\n",
  );
  // App Store versions have zero or one dot; TestFlight versions have two.
  assert.equal(testflightVersion("1.0"), "1.0.1");
  assert.equal(testflightVersion("2"), "2.0.1");
  assert.equal(testflightVersion("1.0.2"), "1.0.2");
  assert.equal(nextPatch("1.0.1"), "1.0.2");
  assert.equal(nextPatch("1.0"), "1.0.1");
  // bin/deployment-decision skips the deployment only for exactly these
  // trailers, as Git reads them.
  const message = versionMessage("1.0.1", "Why it moved.");
  assert.ok(message.split("\n")[0]!.length <= 72);
  const trailers = spawnSync("git", ["interpret-trailers", "--parse"], {
    input: message,
    encoding: "utf8",
  });
  assert.equal(trailers.status, 0, trailers.stderr);
  assert.equal(
    trailers.stdout,
    "Screenr-Deploy: skip\nScreenr-Deploy-Reason: Only the iPhone app's version file changed, and production does not read it.\n",
  );
});

// App Store Connect refused 1.0 (5)'s notes with "Text for whatsNew contains
// invalid characters:'[✨]'".
test("What to Test leaves out emoji, which App Store Connect rejects", () => {
  assert.equal(
    cleanNotes(
      [
        "✨ Show activity times before today as dates  ",
        '♻️ Revert "Add the You tab"',
        "",
        "",
        "",
        "Show the 🎬 trailer badge 👍🏽 again",
        "🇺🇸 Add US streaming services 🎉",
      ].join("\n"),
    ),
    [
      "Show activity times before today as dates",
      'Revert "Add the You tab"',
      "",
      "Show the trailer badge again",
      "Add US streaming services",
    ].join("\n"),
  );
  // The tag message is the notes; tags before 1.0.1 had a title line.
  assert.equal(
    tagNotes("Screenr 1.0 (5)\n\n- Keep the badge in sync\n- Add the You tab"),
    "- Keep the badge in sync\n- Add the You tab",
  );
  assert.equal(tagNotes("Try the You tab.\n"), "Try the You tab.");
});

test("processing waits two hours unless SCREENR_TESTFLIGHT_TIMEOUT_SECONDS says otherwise", () => {
  assert.equal(processingTimeout({}), 2 * 60 * 60_000);
  assert.equal(
    processingTimeout({ SCREENR_TESTFLIGHT_TIMEOUT_SECONDS: "90" }),
    90_000,
  );
  for (const value of ["0", "-5", "1.5", "soon", ""])
    assert.throws(
      () => processingTimeout({ SCREENR_TESTFLIGHT_TIMEOUT_SECONDS: value }),
      {
        message:
          "SCREENR_TESTFLIGHT_TIMEOUT_SECONDS must be a positive whole number of seconds.",
      },
    );
});

test("a release drafts What to Test since the tested build, then checks, archives, uploads, tags, and submits for Beta App Review", async () => {
  let locked = "";
  let fixture: Fixture;
  await withFixture(
    {
      rules: [
        [
          /\/bin\/check-ios --reuse$/,
          () => {
            locked = readFileSync(fixture.lockPath, "utf8");
            return {};
          },
        ],
      ],
    },
    async (created) => {
      fixture = created;
      await fixture.run();
      // llm drafts the notes from the full messages of the app and API
      // commits since build 3, the newest in testing for "Public testers".
      assert.ok(
        fixture.ran(
          /^git log --format=%B%x1e ios-v1\.0\.1b3\.\.c{40} -- ios src\/server src\/app\/api /,
        ),
      );
      const llm = fixture.shell.calls.find(({ command }) => command === "llm");
      assert.deepEqual(llm?.args, ["-s", notesPrompt]);
      assert.match(
        llm?.input ?? "",
        /Add the You tab \(#301\)\n\nTesters asked for it\./,
      );
      assert.match(
        fixture.lines.join("\n"),
        new RegExp(
          `What to Test for the changes since ios-v1\\.0\\.1b3:\\n\\n${drafted}\\n`,
        ),
      );
      // The gate runs bin/check-ios in the terminal before anything is
      // built, while the run holds the lock.
      const gate = fixture.shell.calls.find(
        ({ command }) => command === join(fixture.root, "bin/check-ios"),
      );
      assert.deepEqual(gate?.args, ["--reuse"]);
      assert.equal(gate?.output, "terminal");
      assert.equal(locked, `${process.pid}\n`);
      assert.ok(fixture.at(/\/bin\/check-ios/) < fixture.at(/ios-packages/));
      // The archive builds against the Mac's shared package cache, which
      // bin/ios-packages resolves and holds in use while xcodebuild runs, and
      // requires its symbols to reach Sentry.
      const archive = fixture.shell.calls.find(
        ({ command }) => command === join(fixture.root, "bin/ios-packages"),
      );
      const upload = fixture.shell.calls.find(
        ({ command }) => command === "xcodebuild",
      );
      const directory = join(fixture.root, "ios/build/release/ios-v1.0.1b4");
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
        "xcodebuild",
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
        "SCREENR_REQUIRE_SENTRY_SYMBOLS=YES",
      ]);
      assert.deepEqual(archive?.output, {
        log: join(directory, "archive.log"),
      });
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
      // The tag message is the notes, without the emoji llm added.
      assert.deepEqual(
        fixture.shell.calls.find(({ args }) => args[1] === "--annotate")?.args,
        ["tag", "--annotate", "ios-v1.0.1b4", "--message", drafted, head],
      );
      assert.ok(fixture.git.remote.has("ios-v1.0.1b4"));
      // The build reaches both groups with its notes and goes to review.
      assert.deepEqual(
        fixture.connect.localizations.map(({ build, whatsNew }) => [
          build,
          whatsNew,
        ]),
        [["build-4", drafted]],
      );
      assert.deepEqual(fixture.connect.holding("group-public"), [
        "build-2",
        "build-3",
        "build-4",
      ]);
      assert.equal(
        fixture.connect.build(4)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
      assert.equal(
        fixture.lines.at(-1),
        "==> Screenr 1.0.1 (4) is in Public testers, Screenr team; external testing: WAITING_FOR_BETA_REVIEW.",
      );
      // A TestFlight version needs no version change, and the lock is gone.
      assert.deepEqual(fixture.git.commits, []);
      assert.ok(!fixture.ran(/^git push origin HEAD/));
      assert.ok(!existsSync(fixture.lockPath));
    },
  );
});

test("an App Store version first moves to its TestFlight version, pushed straight to main", async () => {
  await withFixture({ version: "1.0" }, async (fixture) => {
    await fixture.run();
    assert.deepEqual(fixture.git.commits, [
      {
        sha: "d".repeat(40),
        version: "1.0.1",
        message: versionMessage(
          "1.0.1",
          "bin/testflight moved App Store version 1.0 to its first TestFlight version, 1.0.1.",
        ),
      },
    ]);
    assert.equal(
      await readFile(fixture.versionPath, "utf8"),
      "// The app's marketing version.\nMARKETING_VERSION = 1.0.1\n",
    );
    // The commit holds only the version file. It comes after the notes, and
    // bin/check-ios passes it before the push that the pre-push hook checks.
    assert.deepEqual(
      fixture.shell.calls
        .find(({ args }) => args[0] === "commit")
        ?.args.slice(-2),
      ["--", "ios/Config/Version.xcconfig"],
    );
    assert.ok(fixture.at(/^llm /) < fixture.at(/^git commit /));
    assert.ok(fixture.at(/^git commit /) < fixture.at(/\/bin\/check-ios/));
    assert.ok(
      fixture.at(/\/bin\/check-ios/) <
        fixture.at(/^git push origin HEAD:refs\/heads\/main$/),
    );
    assert.ok(
      fixture.at(/^git push origin HEAD:refs\/heads\/main$/) <
        fixture.at(/ios-packages/),
    );
    // The release builds that commit as the next build of 1.0.1.
    assert.equal(fixture.git.main, "d".repeat(40));
    assert.deepEqual(fixture.git.tags.get("ios-v1.0.1b4"), {
      commit: "d".repeat(40),
      message: drafted,
    });
    assert.equal(fixture.connect.build(4)?.version, "1.0.1");
  });
});

test("a version change that could not be pushed stays committed and is pushed by the next run", async () => {
  let refuse = true;
  let fixture: Fixture;
  await withFixture(
    {
      version: "1.0",
      rules: [
        [
          /^git push origin HEAD:refs\/heads\/main$/,
          () => {
            if (refuse) return { status: 1 };
            fixture.git.main = fixture.git.head;
            return {};
          },
        ],
      ],
    },
    async (created) => {
      fixture = created;
      await assert.rejects(fixture.run(), {
        message:
          "Could not push the version change to main. It stays committed here; run bin/testflight again to push it, after rebasing it onto origin/main if main moved.",
      });
      assert.equal(fixture.git.commits.length, 1);
      assert.ok(!fixture.ran(/xcodebuild/));
      assert.ok(!existsSync(fixture.lockPath));

      refuse = false;
      fixture.events.length = 0;
      await fixture.run();
      // The rerun pushes the same commit without another, then releases it.
      assert.equal(fixture.git.commits.length, 1);
      assert.equal(fixture.git.main, "d".repeat(40));
      assert.equal(
        fixture.git.tags.get("ios-v1.0.1b4")?.commit,
        "d".repeat(40),
      );
      assert.ok(
        fixture.at(/^git push origin HEAD:refs\/heads\/main$/) <
          fixture.at(/ios-packages/),
      );
    },
  );
});

test("in a terminal, the drafted notes can be used, edited, or refused", async () => {
  let edited = "";
  await withFixture(
    {
      ask: ["e", ""],
      env: { VISUAL: "code --wait" },
      rules: [
        [
          /^sh -c /,
          ({ args }) => {
            edited = args[3]!;
            assert.equal(readFileSync(edited, "utf8"), `${drafted}\n`);
            writeFileSync(edited, "Try the You tab ✨ and   its picks.\n\n\n");
            return {};
          },
        ],
      ],
    },
    async (fixture) => {
      await fixture.run();
      const editor = fixture.shell.calls.find(
        ({ command }) => command === "sh",
      );
      assert.deepEqual(editor?.args, ["-c", 'code --wait "$1"', "sh", edited]);
      assert.equal(editor?.output, "terminal");
      assert.ok(!existsSync(edited));
      assert.deepEqual(fixture.questions, [
        "Use these notes? [Y/e/n] ",
        "Use these notes? [Y/e/n] ",
      ]);
      assert.equal(
        fixture.git.tags.get("ios-v1.0.1b4")?.message,
        "Try the You tab and its picks.",
      );
    },
  );
  // Refusing the notes stops before anything changes.
  for (const [answers, message, rules] of [
    [
      ["n"],
      "Stopped without the drafted notes. Run bin/testflight again to draft new ones, or pass --notes.",
      [],
    ],
    [
      ["e"],
      "Stopped: the edited notes were empty. Run bin/testflight again, or pass --notes.",
      [
        [
          /^sh -c /,
          ({ args }: Call) => {
            writeFileSync(args[3]!, "🎉\n");
            return {};
          },
        ],
      ],
    ],
    [
      [],
      "The drafted notes have 4001 characters, more than App Store Connect's 4000. Edit them in a terminal, or pass --notes.",
      [[/^llm -s /, { stdout: "x".repeat(4001) }]],
    ],
  ] as [string[], string, Rule[]][])
    await withFixture(
      { version: "1.0", ask: answers, rules },
      async (fixture) => {
        await assert.rejects(fixture.run(), { message });
        assert.deepEqual(fixture.git.commits, []);
        assert.ok(!fixture.ran(building));
        assert.deepEqual(fixture.connect.writes(), []);
      },
    );
  // In a terminal, a draft over App Store Connect's limit can be edited.
  await withFixture(
    {
      ask: ["y", "e", "y"],
      rules: [
        [/^llm -s /, { stdout: "x".repeat(4001) }],
        [
          /^sh -c /,
          ({ args }) => {
            writeFileSync(args[3]!, "Try the You tab.\n");
            return {};
          },
        ],
      ],
    },
    async (fixture) => {
      await fixture.run();
      assert.equal(fixture.questions.length, 3);
      assert.match(
        fixture.lines.join("\n"),
        /Notes must have at most 4000 characters; edit them or stop\./,
      );
      assert.equal(
        fixture.git.tags.get("ios-v1.0.1b4")?.message,
        "Try the You tab.",
      );
    },
  );
});

test("--notes replaces the draft, which needs a build in testing to start from", async () => {
  await withFixture({}, async (fixture) => {
    await fixture.run({ notes: "🎬 Try the You tab." });
    assert.ok(!fixture.ran(/^llm |^git log --format=%B/));
    assert.equal(
      fixture.git.tags.get("ios-v1.0.1b4")?.message,
      "Try the You tab.",
    );
    assert.equal(
      fixture.connect.localizations[0]?.whatsNew,
      "Try the You tab.",
    );
  });
  await withFixture({}, async (fixture) => {
    await assert.rejects(fixture.run({ notes: " 🎉 " }), {
      message:
        "--notes must have 1 to 4000 characters without emoji; they are empty.",
    });
    assert.deepEqual(fixture.events, []);
  });
  // Without a build in testing, the draft has no starting point.
  await withFixture(
    { version: "1.0", connect: { members: { "group-public": [] } } },
    async (fixture) => {
      await assert.rejects(fixture.run(), {
        message:
          'No build is in testing for "Public testers", so What to Test has no starting point. Pass --notes.',
      });
      assert.deepEqual(fixture.git.commits, []);
      assert.ok(!fixture.ran(building));
    },
  );
});

test("an older build of the version waiting for Beta App Review expires after the gate and before the archive", async () => {
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
          {
            version: "1.0.1",
            build: 3,
            externalState: "WAITING_FOR_BETA_REVIEW",
          },
        ],
      },
    },
    async (fixture) => {
      await fixture.run();
      // Build 3 never reached testers, so the notes start at build 2.
      assert.ok(fixture.ran(/^git log --format=%B%x1e ios-v1\.0b2\.\./));
      assert.ok(
        fixture.at(/\/bin\/check-ios/) <
          fixture.at(/^PATCH \/v1\/builds\/build-3$/),
      );
      assert.ok(
        fixture.at(/^PATCH \/v1\/builds\/build-3$/) <
          fixture.at(/ios-packages/),
      );
      assert.equal(fixture.connect.build(3)?.expired, true);
      assert.equal(
        fixture.connect.build(4)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
      assert.deepEqual(fixture.git.commits, []);
    },
  );
});

test("a build Apple is reviewing moves the release to the next patch version, at most once", async () => {
  // Found before the build: the release starts at 1.0.2.
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
          { version: "1.0.1", build: 3, externalState: "IN_BETA_REVIEW" },
        ],
      },
    },
    async (fixture) => {
      await fixture.run();
      assert.deepEqual(
        fixture.git.commits.map(({ version, message }) => [version, message]),
        [
          [
            "1.0.2",
            versionMessage(
              "1.0.2",
              "Apple was reviewing an older build of 1.0.1, so bin/testflight moved to 1.0.2.",
            ),
          ],
        ],
      );
      assert.ok(
        fixture.at(/^git push origin HEAD:refs\/heads\/main$/) <
          fixture.at(/ios-packages/),
      );
      assert.equal(
        fixture.git.tags.get("ios-v1.0.2b4")?.commit,
        "d".repeat(40),
      );
      assert.equal(fixture.connect.build(3)?.externalState, "IN_BETA_REVIEW");
      assert.equal(fixture.connect.build(4)?.version, "1.0.2");
      assert.equal(
        fixture.connect.build(4)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
    },
  );

  // Found after the upload: that build keeps its version and tag, and the
  // release uploads another build of 1.0.2 with the same notes.
  let fixture: Fixture;
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
          { version: "1.0.1", build: 3, externalState: "BETA_APPROVED" },
        ],
      },
      onUpload: (build) => {
        if (build === 4)
          fixture.connect.build(3)!.externalState = "IN_BETA_REVIEW";
      },
    },
    async (created) => {
      fixture = created;
      await fixture.run();
      assert.deepEqual(
        [...fixture.git.tags]
          .filter(([name]) => /b[45]$/.test(name))
          .map(([name, { commit, message }]) => [name, commit, message]),
        [
          ["ios-v1.0.1b4", head, drafted],
          ["ios-v1.0.2b5", "d".repeat(40), drafted],
        ],
      );
      assert.ok(fixture.git.remote.has("ios-v1.0.1b4"));
      assert.ok(fixture.git.remote.has("ios-v1.0.2b5"));
      assert.equal(
        fixture.connect.build(4)?.externalState,
        "READY_FOR_BETA_SUBMISSION",
      );
      assert.equal(
        fixture.connect.build(5)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
      assert.equal(
        fixture.shell.lines().filter((line) => /-exportArchive/.test(line))
          .length,
        2,
      );
    },
  );

  // A review of the next patch version too stops the run.
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
          { version: "1.0.1", build: 3, externalState: "IN_BETA_REVIEW" },
          { version: "1.0.2", build: 1, externalState: "IN_BETA_REVIEW" },
        ],
      },
    },
    async (fixture) => {
      await assert.rejects(fixture.run(), {
        message:
          "Apple is also reviewing an older build of 1.0.2, which this run already moved to. Check TestFlight in App Store Connect, then run bin/testflight again.",
      });
      assert.equal(fixture.git.commits.length, 1);
      assert.ok(!fixture.ran(/xcodebuild/));
    },
  );
});

test("running again on an uploaded commit resumes its distribution without building", async () => {
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0.1", build: 3, externalState: "IN_BETA_TESTING" },
          { version: "1.0.1", build: 4 },
        ],
      },
    },
    async (fixture) => {
      // The earlier run uploaded and tagged build 4 but could not push the tag.
      fixture.git.tags.set("ios-v1.0.1b4", {
        commit: head,
        message: "Try the You tab.",
      });
      await fixture.run();
      assert.ok(!fixture.ran(/xcodebuild|\/bin\/check-ios|^llm |^git commit/));
      assert.ok(fixture.ran(/^git push origin refs\/tags\/ios-v1\.0\.1b4$/));
      assert.equal(
        fixture.connect.localizations[0]?.whatsNew,
        "Try the You tab.",
      );
      assert.equal(
        fixture.connect.build(4)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
      assert.match(
        fixture.lines.join("\n"),
        /This commit is already uploaded as ios-v1\.0\.1b4; resuming its distribution/,
      );
    },
  );
});

test("--distribute-only retries the newest tag's build without building", async () => {
  await withFixture(
    {
      connect: {
        builds: [
          { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
          { version: "1.0.1", build: 3 },
        ],
      },
    },
    async (fixture) => {
      // An older tag's message starts with a title line and has emoji.
      fixture.git.tags.get("ios-v1.0.1b3")!.message =
        "Screenr 1.0.1 (3)\n\n- ✨ Keep the badge in sync";
      fixture.git.status = "?? notes.txt\n";
      await fixture.run({ distributeOnly: true });
      assert.ok(
        !fixture.ran(
          /xcodebuild|\/bin\/check-ios|^llm |^sentry-cli |^git (status|commit|tag --annotate)/,
        ),
      );
      assert.deepEqual(
        fixture.connect.localizations.map(({ build, whatsNew }) => [
          build,
          whatsNew,
        ]),
        [["build-3", "- Keep the badge in sync"]],
      );
      assert.equal(
        fixture.connect.build(3)?.externalState,
        "WAITING_FOR_BETA_REVIEW",
      );
    },
  );
  // It cannot move to the next patch version, and waits as long as the
  // environment says.
  await withFixture(
    {
      env: { SCREENR_TESTFLIGHT_TIMEOUT_SECONDS: "60" },
      connect: {
        builds: [
          { version: "1.0.1", build: 1, externalState: "IN_BETA_REVIEW" },
          { version: "1.0.1", build: 3 },
        ],
      },
    },
    async (fixture) => {
      await assert.rejects(fixture.run({ distributeOnly: true }), {
        message:
          "Apple is reviewing an older build of 1.0.1, so ios-v1.0.1b3 cannot go to Beta App Review. Run bin/testflight without --distribute-only to release the next patch version.",
      });
      fixture.connect.build(3)!.processing = [undefined];
      await assert.rejects(fixture.run({ distributeOnly: true }), {
        message: /^1\.0\.1 \(3\) did not finish processing in 1 minute\./,
      });
    },
  );
});

test("a release keeps the output of the newest three release tags after its upload", async () => {
  await withFixture({}, async (fixture) => {
    const output = join(fixture.root, "ios/build/release");
    for (const name of ["ios-v1.0b1", "ios-v1.0b2", "ios-v1.0.1b3", "notes"])
      await mkdir(join(output, name, "Screenr.xcarchive"), { recursive: true });
    await fixture.run();
    // Only directories named for release tags are release output.
    assert.deepEqual((await readdir(output)).sort(), [
      "ios-v1.0.1b3",
      "ios-v1.0.1b4",
      "ios-v1.0b2",
      "notes",
    ]);
  });
  // A failed upload removes nothing.
  await withFixture(
    { rules: [[/^xcodebuild .*-exportArchive/, { status: 70 }]] },
    async (fixture) => {
      const kept = join(fixture.root, "ios/build/release");
      for (const name of ["ios-v1.0b1", "ios-v1.0b2", "ios-v1.0.1b3"])
        await mkdir(join(kept, name), { recursive: true });
      await assert.rejects(fixture.run(), {
        message: /Uploading failed with status 70/,
      });
      assert.deepEqual((await readdir(kept)).sort(), [
        "ios-v1.0.1b3",
        "ios-v1.0.1b4",
        "ios-v1.0b1",
        "ios-v1.0b2",
      ]);
    },
  );
});

test("a release refuses a dirty, stale, or failing checkout or one without Sentry, and tags nothing after a failed upload", async () => {
  const absent = () => {
    throw Object.assign(new Error("spawn sentry-cli ENOENT"), {
      code: "ENOENT",
    });
  };
  const cases: [string, Rule[], RegExp][] = [
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
      "no sentry-cli",
      [[/^sentry-cli /, absent]],
      /^sentry-cli is not installed, and a release must upload its symbols to Sentry\./,
    ],
    [
      "no Sentry token",
      [[/^sentry-cli /, { stdout: JSON.stringify({ auth: { type: null } }) }]],
      /^sentry-cli has no auth token, and a release must upload its symbols to Sentry\./,
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
  for (const [name, rules, message] of cases)
    await withFixture({ rules }, async (fixture) => {
      await assert.rejects(fixture.run(), { message });
      if (name !== "upload") assert.ok(!fixture.ran(/xcodebuild/), name);
      assert.ok(!fixture.ran(/^git (tag --annotate|push|commit)/), name);
      assert.deepEqual(fixture.connect.writes(), [], name);
      assert.ok(!existsSync(fixture.lockPath), name);
    });
});

test("a release uploads nothing when the checkout changes during the archive", async () => {
  for (const change of [
    (fixture: Fixture) => (fixture.git.status = " M ios/Screenr/App.swift\n"),
    (fixture: Fixture) => (fixture.git.head = "e".repeat(40)),
  ]) {
    let fixture: Fixture;
    await withFixture(
      {
        rules: [
          [
            /\/bin\/ios-packages xcodebuild /,
            () => {
              change(fixture);
              return {};
            },
          ],
        ],
      },
      async (created) => {
        fixture = created;
        await assert.rejects(fixture.run(), {
          message:
            /^The checkout changed while ios-v1\.0\.1b4 was archiving, so nothing was uploaded: (HEAD moved from cccccccccccc to eeeeeeeeeeee|these files changed:\nM ios\/Screenr\/App\.swift)$/,
        });
        assert.ok(!fixture.ran(/-exportArchive|^git tag --annotate/));
      },
    );
  }
});

test("a release holds a lock against concurrent runs from the same clone", async () => {
  await withFixture({}, async (fixture) => {
    await writeFile(fixture.lockPath, `${process.pid}\n`);
    await assert.rejects(fixture.run(), {
      message: `Another bin/testflight, process ${process.pid}, is releasing from this clone. Wait for it to finish; if none is running, remove ${fixture.lockPath}.`,
    });
    assert.deepEqual(fixture.shell.lines(), [
      "git rev-parse --path-format=absolute --git-common-dir",
    ]);
    // A lock being written has no process yet, and also stops a run.
    await writeFile(fixture.lockPath, "");
    await assert.rejects(fixture.run(), {
      message: /^Another bin\/testflight is releasing from this clone\./,
    });
    assert.ok(existsSync(fixture.lockPath));
    // A lock whose process has ended is left from a killed run.
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(fixture.lockPath, `${ended}\n`);
    await fixture.run();
    assert.ok(fixture.git.remote.has("ios-v1.0.1b4"));
    assert.ok(!existsSync(fixture.lockPath));
  });
});

test("a release stops before distribution when GitHub refuses the tag", async () => {
  await withFixture(
    {
      rules: [[/^git push origin refs\/tags\/ios-v1\.0\.1b4$/, { status: 1 }]],
    },
    async (fixture) => {
      await assert.rejects(fixture.run(), {
        message:
          "Could not push ios-v1.0.1b4 to origin.\nios-v1.0.1b4 is uploaded and tagged. Run bin/testflight --distribute-only to retry.",
      });
      assert.deepEqual(fixture.connect.writes(), []);
      assert.deepEqual(fixture.connect.localizations, []);
    },
  );
});
