import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTester,
  appStoreConnect,
  credentialsFrom,
  distribute,
  groupTesters,
  prepareReview,
  removeTester,
  testedBuild,
} from "../../scripts/app-store-connect";
import {
  fakeConnect,
  internalTeam,
  json,
  publicTesters,
  refusal,
  type FakeOptions,
} from "./app-store-connect-fixture";

const app = { id: "app-1", primaryLocale: "en-US" };
const release = { version: "1.0.1", build: 4, notes: "Try the You tab." };

async function withKey<T>(
  run: (key: {
    credentials: ReturnType<typeof credentialsFrom>;
    publicKey: webcrypto.CryptoKey;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "screenr-asc-"));
  try {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(directory, "AuthKey_KEY1234567.p8");
    await writeFile(
      keyPath,
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const publicKey = await webcrypto.subtle.importKey(
      "jwk",
      pair.publicKey.export({ format: "jwk" }),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const credentials = credentialsFrom({
      ASC_KEY_PATH: keyPath,
      ASC_KEY_ID: "KEY1234567",
      ASC_ISSUER_ID: "issuer-uuid",
    });
    return await run({ credentials, publicKey });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// A fake App Store Connect whose app has 1.0.1 (4) uploaded, plus the given
// builds, and the client that talks to it.
async function connected(options: FakeOptions = {}) {
  const connect = fakeConnect({
    groups: [internalTeam, publicTesters],
    ...options,
    builds: [...(options.builds ?? []), { version: "1.0.1", build: 4 }],
  });
  const api = await withKey(({ credentials }) =>
    appStoreConnect(credentials, connect.fetch),
  );
  const lines: string[] = [];
  const waits: number[] = [];
  const waiting = {
    sleep: async (milliseconds: number) => void waits.push(milliseconds),
    log: (line: string) => void lines.push(line),
    timeout: 5 * 60_000,
    interval: 30_000,
  };
  return {
    connect,
    api,
    lines,
    waits,
    distribute: () => distribute(api, app, release, waiting),
    prepare: (expireWaiting: boolean) =>
      prepareReview(api, "app-1", release, {
        expireWaiting,
        log: waiting.log,
      }),
    add: (email: string) => addTester(api, "app-1", email, waiting.log),
    remove: (email: string) => removeTester(api, "app-1", email, waiting.log),
  };
}

test("App Store Connect credentials come from the API key's environment", () => {
  assert.throws(() => credentialsFrom({ ASC_KEY_ID: "KEY1234567" }), {
    message: /ASC_KEY_PATH, ASC_ISSUER_ID/,
  });
});

test("App Store Connect requests carry a short-lived ES256 token for the API key", async () => {
  await withKey(async ({ credentials, publicKey }) => {
    const connect = fakeConnect();
    const now = Date.UTC(2026, 9, 13, 20, 0, 0);
    const api = await appStoreConnect(credentials, connect.fetch, () => now);
    await api.get("/v1/apps?filter[bundleId]=com.artisanalsoftware.Screenr");
    const [request] = connect.requests;
    const token = request!.authorization.replace(/^Bearer /, "");
    const [header, claims, signature] = token.split(".");
    const decode = (segment: string) =>
      JSON.parse(Buffer.from(segment, "base64url").toString());
    assert.deepEqual(decode(header!), {
      alg: "ES256",
      kid: "KEY1234567",
      typ: "JWT",
    });
    const payload = decode(claims!);
    assert.deepEqual(payload, {
      iss: "issuer-uuid",
      iat: now / 1000,
      exp: payload.exp,
      aud: "appstoreconnect-v1",
    });
    assert.ok(
      payload.exp > payload.iat && payload.exp - payload.iat <= 20 * 60,
    );
    assert.ok(
      await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        Buffer.from(signature!, "base64url"),
        Buffer.from(`${header}.${claims}`),
      ),
    );
    await assert.rejects(api.get("/v1/unknown"), {
      message:
        "App Store Connect GET /v1/unknown failed with 404: Not found: No such route.",
    });
    // Page links are full URLs; the token goes only to Apple's API.
    await api.get(
      "https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=x&cursor=2",
    );
    assert.equal(connect.requests.at(-1)?.search.get("cursor"), "2");
    await assert.rejects(api.get("https://example.com/v1/apps"), {
      message: /^Refusing to send an App Store Connect token/,
    });
  });
});

test("distribution waits for processing, sets What to Test, adds the external group, and submits for Beta App Review", async () => {
  const { connect, waits, distribute } = await connected({
    groups: [internalTeam],
    localizations: [{ build: 4, whatsNew: "" }],
  });
  // TestFlight's own processing of a valid build takes one more poll.
  connect.build(4)!.processing = [undefined, "PROCESSING", "VALID"];
  connect.build(4)!.externalState = "PROCESSING";
  const result = await distribute();
  assert.deepEqual(waits, [30_000, 30_000, 30_000]);
  assert.deepEqual(
    connect.localizations.map(({ whatsNew }) => whatsNew),
    ["Try the You tab."],
  );
  // The external group did not exist, so distribution created it without a
  // public link. The internal group already receives every build.
  const created = connect.requests.find(
    ({ method, path }) => method === "POST" && path === "/v1/betaGroups",
  );
  assert.deepEqual(created?.body.data.attributes, {
    name: "Public testers",
    isInternalGroup: false,
    publicLinkEnabled: false,
    feedbackEnabled: true,
  });
  assert.deepEqual(connect.holding("group-new"), ["build-4"]);
  assert.deepEqual(result, {
    nextVersion: false,
    build: "build-4",
    groups: ["Public testers", "Screenr team"],
    externalState: "WAITING_FOR_BETA_REVIEW",
  });
  assert.ok(
    !connect.requests.some(
      ({ body }) => body?.data?.attributes?.publicLinkEnabled,
    ),
  );
});

test("distribution reaches an internal group without automatic access, and running it again changes only the notes", async () => {
  const { connect, distribute } = await connected({
    groups: [{ ...internalTeam, hasAccessToAllBuilds: false }, publicTesters],
  });
  await distribute();
  assert.deepEqual(connect.holding("group-team"), ["build-4"]);
  assert.deepEqual(connect.holding("group-public"), ["build-4"]);
  assert.deepEqual(connect.writes(), [
    "POST /v1/betaBuildLocalizations",
    "POST /v1/betaGroups/group-public/relationships/builds",
    "POST /v1/betaGroups/group-team/relationships/builds",
    "POST /v1/betaAppReviewSubmissions",
  ]);
  connect.requests.length = 0;
  const again = await distribute();
  assert.deepEqual(connect.writes(), [
    "PATCH /v1/betaBuildLocalizations/loc-1",
  ]);
  assert.equal(
    again.nextVersion || again.externalState,
    "WAITING_FOR_BETA_REVIEW",
  );
});

test("distribution stops when Apple rejects or never finishes the build", async () => {
  for (const state of ["FAILED", "INVALID"]) {
    const { connect, distribute } = await connected();
    connect.build(4)!.processing = [state];
    await assert.rejects(distribute(), {
      message: `App Store Connect marked 1.0.1 (4) ${state}. Check the build's email from Apple and TestFlight's Build Uploads.`,
    });
  }
  const { connect, distribute } = await connected();
  connect.build(4)!.processing = [undefined];
  await assert.rejects(distribute(), {
    message:
      "1.0.1 (4) did not finish processing in 5 minutes. Check TestFlight's Build Uploads in App Store Connect; while it is still processing, run bin/testflight --distribute-only to keep waiting. SCREENR_TESTFLIGHT_TIMEOUT_SECONDS sets a longer wait.",
  });
  assert.deepEqual(connect.writes(), []);
});

test("distribution reports why App Store Connect refused the external group", async () => {
  const { connect, distribute } = await connected({
    groups: [internalTeam],
    createGroup: () =>
      refusal(
        409,
        "The request entity is not valid.",
        "External groups need a build first.",
      ),
  });
  await assert.rejects(distribute(), {
    message:
      'Could not create the external group "Public testers": App Store Connect POST /v1/betaGroups failed with 409: The request entity is not valid.: External groups need a build first. Create it in TestFlight in App Store Connect, then run bin/testflight --distribute-only.',
  });
  // What to Test is already set, so internal testers see the notes.
  assert.equal(connect.localizations[0]?.whatsNew, "Try the You tab.");
});

test("the tested build is the newest one in testing for the external group", async () => {
  const { connect, api } = await connected({
    pageSize: 1,
    builds: [
      { version: "1.0", build: 1, externalState: "IN_BETA_TESTING" },
      { version: "1.0", build: 2, externalState: "IN_BETA_TESTING" },
      // Expired while waiting for review, so testers never had it.
      { version: "1.0.1", build: 3, externalState: "EXPIRED", expired: true },
      { version: "1.0.2", build: 5, externalState: "WAITING_FOR_BETA_REVIEW" },
      { version: "1.0.2", build: 6, externalState: "IN_BETA_TESTING" },
    ],
    members: { "group-public": [1, 2, 3, 5], "group-team": [6] },
  });
  // Build 5, still waiting for review, fills the first page, so the answer
  // comes from the second.
  assert.equal(await testedBuild(api, "app-1"), 2);
  const lists = connect.requests.filter(({ path }) => path === "/v1/builds");
  assert.equal(lists.length, 2);
  assert.equal(lists[0]!.search.get("filter[betaGroups]"), "group-public");
  assert.equal(lists[0]!.search.get("filter[expired]"), "false");
  assert.equal(lists[0]!.search.get("sort"), "-uploadedDate");
  assert.equal(lists[1]!.search.get("cursor"), "1");

  const untested = await connected({
    builds: [
      { version: "1.0", build: 1, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
    members: { "group-public": [1] },
  });
  assert.equal(await testedBuild(untested.api, "app-1"), undefined);
  const groupless = await connected({ groups: [internalTeam] });
  assert.equal(await testedBuild(groupless.api, "app-1"), undefined);
});

test("an older build of the version waiting for Beta App Review expires only when asked", async () => {
  const waiting = {
    version: "1.0.1",
    build: 3,
    externalState: "WAITING_FOR_BETA_REVIEW",
  };
  const { connect, prepare, lines } = await connected({
    builds: [
      waiting,
      // Other versions and builds that are not in review stay.
      { version: "1.0", build: 2, externalState: "WAITING_FOR_BETA_REVIEW" },
      { version: "1.0.1", build: 1, externalState: "IN_BETA_TESTING" },
    ],
  });
  assert.equal(await prepare(false), "ready");
  assert.deepEqual(connect.writes(), []);
  assert.equal(await prepare(true), "ready");
  assert.deepEqual(connect.writes(), ["PATCH /v1/builds/build-3"]);
  assert.equal(connect.build(3)!.expired, true);
  assert.equal(connect.build(2)!.expired, false);
  assert.match(
    lines.join("\n"),
    /Expiring 1\.0\.1 \(3\), which is waiting for Beta App Review/,
  );
  // Nothing is left to replace.
  assert.equal(await prepare(true), "ready");
  assert.deepEqual(connect.writes(), ["PATCH /v1/builds/build-3"]);
});

test("an older build of the version in Beta App Review keeps its review and asks for the next patch version", async () => {
  const { connect, prepare } = await connected({
    builds: [{ version: "1.0.1", build: 3, externalState: "IN_BETA_REVIEW" }],
  });
  assert.equal(await prepare(false), "next-version");
  assert.equal(await prepare(true), "next-version");
  assert.deepEqual(connect.writes(), []);

  // Apple can start the review just before the expiry.
  const starting = await connected({
    builds: [
      { version: "1.0.1", build: 3, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
    expire: (build) => {
      build.externalState = "IN_BETA_REVIEW";
      return refusal(
        409,
        "The request entity is not valid.",
        "The build is in review.",
      );
    },
  });
  assert.equal(await starting.prepare(true), "next-version");
  assert.equal(starting.connect.build(3)!.expired, false);
});

test("replacing a review submission stops on anything but one older waiting build", async () => {
  const several = await connected({
    builds: [
      { version: "1.0.1", build: 2, externalState: "WAITING_FOR_BETA_REVIEW" },
      { version: "1.0.1", build: 3, externalState: "IN_BETA_REVIEW" },
    ],
  });
  await assert.rejects(several.prepare(true), {
    message:
      "Cannot replace the Beta App Review submissions of 1.0.1 (2), WAITING_FOR_BETA_REVIEW; 1.0.1 (3), IN_BETA_REVIEW. Expected one older build of 1.0.1.",
  });
  const newer = await connected({
    builds: [
      { version: "1.0.1", build: 5, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
  });
  await assert.rejects(newer.prepare(false), {
    message: /^Cannot replace the Beta App Review submissions of 1\.0\.1 \(5\)/,
  });
  const refused = await connected({
    builds: [
      { version: "1.0.1", build: 3, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
    expire: () => refusal(403, "Forbidden", "The key cannot expire builds."),
  });
  await assert.rejects(refused.prepare(true), {
    message:
      "App Store Connect PATCH /v1/builds/build-3 failed with 403: Forbidden: The key cannot expire builds.",
  });
  const unconfirmed = await connected({
    builds: [
      { version: "1.0.1", build: 3, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
    expire: () => json(200, {}),
  });
  await assert.rejects(unconfirmed.prepare(true), {
    message:
      "App Store Connect has not confirmed that 1.0.1 (3) expired, so nothing was submitted in its place. Run bin/testflight again.",
  });
  for (const { connect } of [several, newer, refused, unconfirmed])
    assert.ok(!connect.writes().includes("POST /v1/betaAppReviewSubmissions"));
});

test("distribution replaces an older waiting submission, or asks for the next patch version while Apple reviews one", async () => {
  const replacing = await connected({
    builds: [
      { version: "1.0.1", build: 3, externalState: "WAITING_FOR_BETA_REVIEW" },
    ],
  });
  const replaced = await replacing.distribute();
  assert.equal(replaced.nextVersion, false);
  assert.equal(replacing.connect.build(3)!.expired, true);
  assert.equal(
    replacing.connect.build(4)!.externalState,
    "WAITING_FOR_BETA_REVIEW",
  );

  const reviewing = await connected({
    builds: [{ version: "1.0.1", build: 3, externalState: "IN_BETA_REVIEW" }],
  });
  assert.deepEqual(await reviewing.distribute(), { nextVersion: true });
  // The build is in the groups with its notes, but not submitted.
  assert.deepEqual(reviewing.connect.holding("group-public"), ["build-4"]);
  assert.ok(
    !reviewing.connect.writes().includes("POST /v1/betaAppReviewSubmissions"),
  );

  // Apple refuses a submission while another build of the version is in
  // review, such as one submitted after the check.
  const racing = await connected({
    builds: [{ version: "1.0.1", build: 3, externalState: "BETA_APPROVED" }],
    submit: () => {
      racing.connect.build(3)!.externalState = "IN_BETA_REVIEW";
      return refusal(
        409,
        "The request entity is not valid.",
        "Another build is in review.",
      );
    },
  });
  assert.deepEqual(await racing.distribute(), { nextVersion: true });
  assert.match(
    racing.lines.join("\n"),
    /Apple refused the submission: .*Another build is in review\./,
  );

  const unexplained = await connected({
    submit: () =>
      refusal(
        409,
        "The request entity is not valid.",
        "Another build is in review.",
      ),
  });
  await assert.rejects(unexplained.distribute(), {
    message:
      "Apple still reports another build in Beta App Review. Check TestFlight in App Store Connect, then run bin/testflight --distribute-only.",
  });
  const other = await connected({
    submit: () => refusal(422, "Unprocessable", "Review details are missing."),
  });
  await assert.rejects(other.distribute(), {
    message:
      "App Store Connect POST /v1/betaAppReviewSubmissions failed with 422: Unprocessable: Review details are missing.",
  });
});

test("distribution stops when external testing needs attention", async () => {
  const { connect, distribute } = await connected();
  connect.build(4)!.externalState = "BETA_REJECTED";
  await assert.rejects(distribute(), {
    message:
      'The build is in "Public testers", but external testing needs attention: it is BETA_REJECTED. Check TestFlight in App Store Connect.',
  });
  assert.ok(!connect.writes().includes("POST /v1/betaAppReviewSubmissions"));
});

test("adding a tester creates them in the external group, which invites them, and adding them again changes nothing", async () => {
  const { connect, add, lines } = await connected();
  assert.deepEqual(await add("friend@example.com"), {
    added: true,
    invited: false,
    state: "INVITED",
  });
  // One request creates the tester in "Public testers"; Apple's invitation
  // comes with it, so none is sent separately.
  assert.deepEqual(connect.writes(), ["POST /v1/betaTesters"]);
  const created = connect.requests.find(
    ({ method, path }) => method === "POST" && path === "/v1/betaTesters",
  );
  assert.deepEqual(created?.body, {
    data: {
      type: "betaTesters",
      attributes: { email: "friend@example.com" },
      relationships: {
        betaGroups: { data: [{ type: "betaGroups", id: "group-public" }] },
      },
    },
  });
  assert.deepEqual(connect.inGroup("group-public"), [
    "friend@example.com INVITED",
  ]);
  assert.match(
    lines.join("\n"),
    /friend@example\.com is in "Public testers"; TestFlight lists them as INVITED\./,
  );
  // Apple matches emails without regard to case.
  assert.deepEqual(await add("Friend@Example.com"), {
    added: false,
    invited: false,
    state: "INVITED",
  });
  assert.deepEqual(connect.writes(), ["POST /v1/betaTesters"]);
  assert.equal(
    lines.at(-1),
    '==> Friend@Example.com is already in "Public testers" as INVITED; nothing changed.',
  );
});

test("a tester of another app joins through the group's relationship, and anyone Apple has not invited gets an invitation", async () => {
  const { connect, add } = await connected({
    joinedState: "NOT_INVITED",
    testers: [
      // A PodHaven tester on the same team, and one who left Screenr.
      { email: "podhaven@example.com", groups: ["group-podhaven"] },
      { email: "left@example.com", groups: ["group-public"], state: "REVOKED" },
    ],
  });
  assert.deepEqual(await add("podhaven@example.com"), {
    added: true,
    invited: true,
    state: "NOT_INVITED",
  });
  assert.deepEqual(connect.writes(), [
    "POST /v1/betaGroups/group-public/relationships/betaTesters",
    "POST /v1/betaTesterInvitations",
  ]);
  const [joined, invitation] = connect.requests.filter(
    ({ method }) => method === "POST",
  );
  assert.deepEqual(joined?.body, {
    data: [{ type: "betaTesters", id: "tester-1" }],
  });
  assert.deepEqual(invitation?.body, {
    data: {
      type: "betaTesterInvitations",
      relationships: {
        app: { data: { type: "apps", id: "app-1" } },
        betaTester: { data: { type: "betaTesters", id: "tester-1" } },
      },
    },
  });
  assert.deepEqual(connect.invitations, [{ app: "app-1", tester: "tester-1" }]);

  // A tester who left counts as gone, so adding them joins and invites
  // them again; so does a new tester Apple did not invite.
  connect.requests.length = 0;
  assert.equal((await add("left@example.com")).added, true);
  assert.equal((await add("new@example.com")).invited, true);
  assert.deepEqual(connect.writes(), [
    "POST /v1/betaGroups/group-public/relationships/betaTesters",
    "POST /v1/betaTesterInvitations",
    "POST /v1/betaTesters",
    "POST /v1/betaTesterInvitations",
  ]);
  assert.deepEqual(connect.inGroup("group-public"), [
    "left@example.com INVITED",
    "new@example.com INVITED",
    "podhaven@example.com INVITED",
  ]);

  // A tester still in the group whom Apple has not invited gets one too.
  const waiting = await connected({
    testers: [
      {
        email: "waiting@example.com",
        groups: ["group-public"],
        state: "NOT_INVITED",
      },
    ],
  });
  assert.deepEqual(await waiting.add("waiting@example.com"), {
    added: false,
    invited: true,
    state: "NOT_INVITED",
  });
  assert.deepEqual(waiting.connect.writes(), [
    "POST /v1/betaTesterInvitations",
  ]);
});

test("removing a tester takes them out of the external group, and removing someone not in it changes nothing", async () => {
  const { connect, remove, lines } = await connected({
    testers: [
      { email: "friend@example.com", groups: ["group-public", "group-team"] },
      { email: "pal@example.com", groups: ["group-public"] },
      { email: "podhaven@example.com", groups: ["group-podhaven"] },
    ],
  });
  assert.equal(await remove("FRIEND@example.com"), true);
  // Only the group membership goes; the tester stays on the team.
  assert.deepEqual(connect.writes(), [
    "DELETE /v1/betaGroups/group-public/relationships/betaTesters",
  ]);
  assert.deepEqual(connect.requests.at(-2)?.body, {
    data: [{ type: "betaTesters", id: "tester-1" }],
  });
  assert.deepEqual(connect.inGroup("group-public"), [
    "pal@example.com INSTALLED",
  ]);
  assert.deepEqual(connect.inGroup("group-team"), [
    "friend@example.com INSTALLED",
  ]);
  assert.equal(
    lines.at(-1),
    '==> FRIEND@example.com is no longer in "Public testers".',
  );
  for (const email of ["friend@example.com", "podhaven@example.com"]) {
    assert.equal(await remove(email), false);
    assert.equal(
      lines.at(-1),
      `==> ${email} is not in "Public testers"; nothing changed.`,
    );
  }
  assert.equal(connect.writes().length, 1);

  // Apple may keep listing a removed tester as REVOKED.
  const revoking = await connected({
    revokeOnRemoval: true,
    testers: [{ email: "friend@example.com", groups: ["group-public"] }],
  });
  assert.equal(await revoking.remove("friend@example.com"), true);
  assert.equal(await revoking.remove("friend@example.com"), false);
  assert.equal(revoking.connect.writes().length, 1);
});

test("the external group's testers are listed across pages", async () => {
  const { connect, api } = await connected({
    pageSize: 2,
    testers: [
      { email: "zed@example.com", groups: ["group-public"], state: "INVITED" },
      { firstName: "Anonymous", groups: ["group-public"] },
      {
        email: "amy@example.com",
        firstName: "Amy",
        lastName: "Lee",
        groups: ["group-public"],
      },
      { email: "podhaven@example.com", groups: ["group-podhaven"] },
    ],
  });
  assert.deepEqual(await groupTesters(api, "app-1"), [
    {
      id: "tester-3",
      email: "amy@example.com",
      name: "Amy Lee",
      inviteType: "EMAIL",
      state: "INSTALLED",
    },
    {
      id: "tester-1",
      email: "zed@example.com",
      name: "",
      inviteType: "EMAIL",
      state: "INVITED",
    },
    {
      id: "tester-2",
      email: undefined,
      name: "Anonymous",
      inviteType: "PUBLIC_LINK",
      state: "INSTALLED",
    },
  ]);
  const pages = connect.requests.filter(({ path }) =>
    path.endsWith("/betaTesters"),
  );
  assert.deepEqual(
    pages.map(({ path, search }) => [path, search.get("cursor")]),
    [
      ["/v1/betaGroups/group-public/betaTesters", null],
      ["/v1/betaGroups/group-public/betaTesters", "2"],
    ],
  );
  assert.equal(
    pages[0]!.search.get("fields[betaTesters]"),
    "email,firstName,lastName,inviteType,state",
  );
});

test("tester changes stop without the external group or when App Store Connect does not confirm them", async () => {
  const groupless = await connected({ groups: [internalTeam] });
  for (const change of [groupless.add, groupless.remove])
    await assert.rejects(change("friend@example.com"), {
      message:
        'App Store Connect has no external group "Public testers". A bin/testflight release creates it.',
    });
  await assert.rejects(groupTesters(groupless.api, "app-1"), {
    message: /has no external group "Public testers"/,
  });
  assert.deepEqual(groupless.connect.writes(), []);

  const unconfirmed = await connected({
    createTester: () =>
      json(201, { data: { type: "betaTesters", id: "tester-9" } }),
  });
  await assert.rejects(unconfirmed.add("friend@example.com"), {
    message:
      'App Store Connect does not list friend@example.com in "Public testers". Run bin/testflight --add-tester friend@example.com again.',
  });
  const refused = await connected({
    createTester: () => refusal(422, "Unprocessable", "Invalid email."),
  });
  await assert.rejects(refused.add("friend@example.com"), {
    message:
      "App Store Connect POST /v1/betaTesters failed with 422: Unprocessable: Invalid email.",
  });
  const kept = await connected({
    removeTester: () => json(204),
    testers: [{ email: "friend@example.com", groups: ["group-public"] }],
  });
  await assert.rejects(kept.remove("friend@example.com"), {
    message:
      'App Store Connect still lists friend@example.com in "Public testers". Run bin/testflight --remove-tester friend@example.com again.',
  });
});
