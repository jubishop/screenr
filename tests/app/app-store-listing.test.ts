import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appStoreConnect,
  credentialsFrom,
} from "../../scripts/app-store-connect";
import {
  parseCommand,
  parseListing,
  pngShape,
  productionReviewDetails,
  readListing,
  reviewNotes,
  takeScreenshots,
  type ReviewDetails,
  type Screenshot,
} from "../../scripts/app-store-listing";
import {
  descriptionText,
  keywordsText,
  readOnly,
  syncListing,
} from "../../scripts/app-store-listing-sync";
import {
  fakeListing,
  uploadHost,
  type ListingOptions,
} from "./app-store-listing-fixture";

const root = join(import.meta.dirname, "../..");
const app = { id: "app-1", primaryLocale: "en-US" };
const now = Date.UTC(2026, 10, 9, 20);
const day = 86_400_000;
const signInCode = "730194";
const review: ReviewDetails = {
  reviewer: "review@screenr.club",
  signInCode,
  invitation: {
    url: `https://screenr.club/join/${"a".repeat(43)}`,
    expiresAt: new Date(now + 90 * day).toISOString(),
    remaining: 12,
  },
};

// The header of a PNG of this size, which is all the checks read, and a
// tail that makes each file distinct.
function png(width: number, height: number, tail: string, colorType = 2) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = colorType;
  return Buffer.concat([header, Buffer.from(tail)]);
}
const screenshot = (fileName: string, tail = fileName): Screenshot => {
  const bytes = png(1206, 2622, tail);
  return {
    fileName,
    bytes,
    checksum: createHash("md5").update(bytes).digest("hex"),
  };
};

const listingSource = () =>
  readFile(join(root, "app-store/listing.json"), "utf8");

// A fake App Store Connect, a client for it, and the repository's listing
// with stand-in screenshots.
async function connected(options: ListingOptions = {}) {
  const connect = fakeListing(options);
  const directory = await mkdtemp(join(tmpdir(), "screenr-listing-"));
  try {
    const keyPath = join(directory, "AuthKey_KEY1234567.p8");
    await writeFile(
      keyPath,
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    );
    const api = await appStoreConnect(
      credentialsFrom({
        ASC_KEY_PATH: keyPath,
        ASC_KEY_ID: "KEY1234567",
        ASC_ISSUER_ID: "issuer-uuid",
      }),
      connect.fetch,
    );
    const listing = parseListing(await listingSource());
    const lines: string[] = [];
    let screenshots = {
      APP_IPHONE_61: ["1-feed.png", "2-title.png", "3-profile.png"].map(
        (name) => screenshot(name),
      ),
    };
    const sync = (
      settings: {
        apply?: boolean;
        review?: ReviewDetails;
        version?: string;
      } = {},
    ) => {
      const details = "review" in settings ? settings.review : review;
      return syncListing(
        settings.apply === false ? readOnly(api) : api,
        app,
        {
          listing,
          screenshots,
          review: details && {
            signInCode: details.signInCode,
            notes: reviewNotes(listing, details, now),
          },
          version: settings.version,
        },
        {
          apply: settings.apply ?? true,
          log: (line: string) => void lines.push(line),
          sleep: async () => {},
          timeout: 60_000,
          interval: 1_000,
        },
      );
    };
    return {
      connect,
      api,
      listing,
      lines,
      sync,
      setScreenshots: (files: Screenshot[]) => {
        screenshots = { APP_IPHONE_61: files };
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the repository's listing fits App Store Connect's limits, with opaque screenshots at the required size", async () => {
  const { listing, screenshots } = await readListing(root);
  assert.ok([...listing.subtitle].length <= 30);
  assert.ok([...listing.promotionalText].length <= 170);
  assert.ok([...descriptionText(listing)].length <= 4000);
  assert.ok(keywordsText(listing).length <= 100);
  assert.equal(listing.review.demoAccountName, "review@screenr.club");
  assert.deepEqual(listing.availability, {
    territories: ["USA"],
    availableInNewTerritories: false,
  });
  assert.equal(listing.ageRating.ageRatingOverrideV2, "EIGHTEEN_PLUS");
  assert.equal(listing.ageRating.userGeneratedContent, true);
  const shots = screenshots.APP_IPHONE_61!;
  assert.ok(shots.length >= 1 && shots.length <= 10);
  for (const { bytes } of shots)
    assert.deepEqual(pngShape(bytes), {
      width: 1206,
      height: 2622,
      alpha: false,
    });
  // The notes fit once production's code and link are in place.
  assert.match(reviewNotes(listing, review, now), /730194/);
});

test("a listing that breaks App Store Connect's rules stops before anything changes", async () => {
  const valid = JSON.parse(await listingSource());
  const broken = (change: (listing: any) => void) => {
    const listing = structuredClone(valid);
    change(listing);
    return () => parseListing(JSON.stringify(listing));
  };
  assert.throws(
    broken((listing) => (listing.subtitle = "s".repeat(31))),
    { message: /subtitle has 31 characters; App Store Connect allows 30/ },
  );
  assert.throws(
    broken((listing) => (listing.keywords = ["tv, film"])),
    { message: /must not contain commas/ },
  );
  assert.throws(
    broken((listing) => listing.keywords.push("x".repeat(40))),
    { message: /keywords has \d+ characters; App Store Connect allows 100/ },
  );
  assert.throws(
    broken(
      (listing) => (listing.review.notes = ["Sign in with {signInCode}."]),
    ),
    { message: "The listing's review notes must include {invitation}." },
  );
  assert.throws(
    broken((listing) => (listing.supportUrl = "http://screenr.club/support")),
    { message: "The listing's supportUrl must be an HTTPS URL." },
  );
  assert.throws(
    broken((listing) => (listing.screenshots = { APP_IPHONE_67: ["a.png"] })),
    { message: /name APP_IPHONE_67, which has no known sizes/ },
  );
  assert.throws(
    broken((listing) => (listing.ageRating = { advertising: 0 })),
    { message: /must answer each question/ },
  );
});

test("screenshots must be PNGs of an accepted size without alpha", async () => {
  assert.deepEqual(pngShape(png(1179, 2556, "x")), {
    width: 1179,
    height: 2556,
    alpha: false,
  });
  assert.equal(
    pngShape(Buffer.from("not a png at all, not even close here")),
    undefined,
  );
  const directory = await mkdtemp(join(tmpdir(), "screenr-listing-root-"));
  try {
    const folder = join(directory, "app-store/screenshots/APP_IPHONE_61");
    await mkdir(folder, { recursive: true });
    const listing = JSON.parse(await listingSource());
    listing.screenshots = { APP_IPHONE_61: ["a.png", "b.png"] };
    await writeFile(
      join(directory, "app-store/listing.json"),
      JSON.stringify(listing),
    );
    const files = async (a: Buffer, b: Buffer) => {
      await writeFile(join(folder, "a.png"), a);
      await writeFile(join(folder, "b.png"), b);
      return readListing(directory);
    };
    await assert.rejects(files(png(1206, 2622, "a"), png(1320, 2868, "b")), {
      message:
        "app-store/screenshots/APP_IPHONE_61/b.png is 1320 × 2868; App Store Connect takes APP_IPHONE_61 screenshots of 1206 × 2622 or 1179 × 2556.",
    });
    await assert.rejects(files(png(1206, 2622, "a"), png(1206, 2622, "b", 6)), {
      message:
        "app-store/screenshots/APP_IPHONE_61/b.png has an alpha channel, which App Store Connect refuses.",
    });
    await assert.rejects(files(png(1206, 2622, "a"), png(1206, 2622, "a")), {
      message: "Two of the APP_IPHONE_61 screenshots are the same file.",
    });
    const { screenshots } = await files(
      png(1206, 2622, "a"),
      png(1206, 2622, "b"),
    );
    assert.deepEqual(
      screenshots.APP_IPHONE_61!.map(({ fileName }) => fileName),
      ["a.png", "b.png"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the first sync sets every part of the listing, and running it again changes nothing", async () => {
  const { connect, sync, lines, listing } = await connected();
  const changes = await sync();
  assert.equal(changes.length, 9);
  assert.deepEqual(connect.writes(), [
    "PATCH /v1/appStoreVersions/version-1",
    "PATCH /v1/appStoreVersionLocalizations/localization-1",
    "PATCH /v1/appInfos/info-1",
    "PATCH /v1/appInfoLocalizations/info-1-en-US",
    "PATCH /v1/ageRatingDeclarations/info-1",
    "PATCH /v1/apps/app-1",
    "POST /v2/appAvailabilities",
    "POST /v1/appStoreReviewDetails",
    "POST /v1/appScreenshotSets",
    "POST /v1/appScreenshots",
    "PATCH /v1/appScreenshots/shot-3",
    "POST /v1/appScreenshots",
    "PATCH /v1/appScreenshots/shot-4",
    "POST /v1/appScreenshots",
    "PATCH /v1/appScreenshots/shot-5",
    "PATCH /v1/appScreenshotSets/set-2/relationships/appScreenshots",
  ]);

  // The version and the app hold the listing.
  assert.equal(connect.versions[0]!.attributes.copyright, listing.copyright);
  assert.deepEqual(connect.localizations[0]!.attributes, {
    locale: "en-US",
    description: descriptionText(listing),
    keywords: keywordsText(listing),
    promotionalText: listing.promotionalText,
    supportUrl: "https://screenr.club/support",
    marketingUrl: "https://screenr.club",
    whatsNew: null,
  });
  const [info] = connect.infos;
  assert.deepEqual(info!.categories, {
    primaryCategory: "ENTERTAINMENT",
    secondaryCategory: "SOCIAL_NETWORKING",
  });
  assert.deepEqual(info!.localization.attributes, {
    locale: "en-US",
    name: "Screenr",
    subtitle: listing.subtitle,
    privacyPolicyUrl: "https://screenr.club/privacy",
  });
  assert.deepEqual(info!.ageRating, listing.ageRating);
  assert.equal(
    connect.app.contentRightsDeclaration,
    "USES_THIRD_PARTY_CONTENT",
  );

  // Every territory is listed in the availability, and only the US is on.
  assert.equal(connect.availability()?.availableInNewTerritories, false);
  assert.deepEqual(connect.available(), ["USA"]);
  assert.equal(connect.availability()?.rows.size, 3);

  // The review information copies TestFlight's contact and carries the code
  // and the demo invitation, which the log never shows.
  const detail = connect.reviewDetail()!.attributes;
  assert.deepEqual(
    { ...detail, notes: undefined },
    {
      ...connect.contact,
      demoAccountName: "review@screenr.club",
      demoAccountPassword: signInCode,
      demoAccountRequired: true,
      notes: undefined,
    },
  );
  assert.match(String(detail.notes), new RegExp(`code ${signInCode} `));
  assert.ok(String(detail.notes).includes(review.invitation.url));
  const logged = lines.join("\n");
  for (const secret of [
    signInCode,
    "5550100",
    "owner@example.com",
    "a".repeat(43),
  ])
    assert.ok(!logged.includes(secret), `the log shows ${secret}`);

  // The screenshots went up in parts to Apple's upload host, without the
  // token, and finished in the listing's order.
  const shots = connect.screenshots.get(connect.sets[0]!.id)!;
  assert.deepEqual(
    shots.map(({ fileName, state }) => `${fileName} ${state}`),
    ["1-feed.png COMPLETE", "2-title.png COMPLETE", "3-profile.png COMPLETE"],
  );
  for (const shot of shots) {
    const sent = Buffer.concat(shot.received);
    assert.equal(shot.checksum, createHash("md5").update(sent).digest("hex"));
    assert.equal(shot.fileSize, sent.length);
  }
  assert.equal(connect.uploads.length, 6);
  assert.ok(
    connect.uploads.every(
      ({ url, authorization }) => url.startsWith(uploadHost) && !authorization,
    ),
  );

  // A rerun finds everything in place.
  connect.requests.length = 0;
  lines.length = 0;
  assert.deepEqual(await sync(), []);
  assert.deepEqual(connect.writes(), []);
  assert.ok(lines.every((line) => !line.startsWith("==> Setting")));
});

test("a dry run reports the changes a sync would make and writes nothing", async () => {
  const dry = await connected();
  const planned = await dry.sync({ apply: false });
  assert.deepEqual(dry.connect.writes(), []);
  assert.ok(
    dry.lines.some((line) =>
      line.startsWith("==> Would create the availability"),
    ),
  );
  const real = await connected();
  const made = await real.sync();
  assert.deepEqual(planned, made);
  // A dry run's client refuses writes outright.
  await assert.rejects(readOnly(dry.api).patch("/v1/apps/app-1", {}), {
    message: "A dry run tried to change App Store Connect.",
  });
});

test("a changed screenshot replaces only that one, in the listing's order", async () => {
  const { connect, sync, setScreenshots } = await connected();
  await sync();
  const [feed, , profile] = connect.screenshots.get("set-2")!;
  setScreenshots([
    screenshot("1-feed.png"),
    screenshot("2-title.png", "a new title page"),
    screenshot("3-profile.png"),
  ]);
  connect.requests.length = 0;
  const changes = await sync();
  assert.deepEqual(changes, [
    "Setting the APP_IPHONE_61 screenshots: uploading 2-title.png, deleting 1, ordering them as listed",
  ]);
  const writes = connect.writes();
  assert.equal(writes.filter((write) => write.startsWith("DELETE")).length, 1);
  assert.equal(
    writes.filter((write) => write === "POST /v1/appScreenshots").length,
    1,
  );
  const shots = connect.screenshots.get("set-2")!;
  assert.deepEqual(
    shots.map(({ id }) => id),
    [feed!.id, "shot-6", profile!.id],
  );
  assert.equal(
    shots[1]!.checksum,
    screenshot("2-title.png", "a new title page").checksum,
  );

  // Reordering alone moves them without uploading.
  setScreenshots([
    screenshot("3-profile.png"),
    screenshot("1-feed.png"),
    screenshot("2-title.png", "a new title page"),
  ]);
  connect.requests.length = 0;
  await sync();
  assert.deepEqual(connect.writes(), [
    "PATCH /v1/appScreenshotSets/set-2/relationships/appScreenshots",
  ]);
  assert.deepEqual(
    connect.screenshots.get("set-2")!.map(({ fileName }) => fileName),
    ["3-profile.png", "1-feed.png", "2-title.png"],
  );
});

test("a screenshot Apple cannot process stops the sync, and a rerun replaces it", async () => {
  let failing = true;
  const { connect, sync } = await connected({
    processing: (fileName) =>
      fileName === "2-title.png" && failing
        ? ["UPLOAD_COMPLETE", "FAILED"]
        : ["UPLOAD_COMPLETE", "COMPLETE"],
  });
  await assert.rejects(sync(), {
    message: "App Store Connect could not process 2-title.png: no details.",
  });
  failing = false;
  await sync();
  assert.deepEqual(
    connect.screenshots
      .get("set-2")!
      .map(({ fileName, state }) => `${fileName} ${state}`),
    ["1-feed.png COMPLETE", "2-title.png COMPLETE", "3-profile.png COMPLETE"],
  );
  assert.ok(connect.writes().includes("DELETE /v1/appScreenshots/shot-4"));

  const stuck = await connected({ processing: () => ["UPLOAD_COMPLETE"] });
  await assert.rejects(stuck.sync(), {
    message:
      "App Store Connect did not finish processing 1-feed.png in 60 seconds. Run this again, which replaces it if it is still unfinished.",
  });
});

test("availability narrows an existing one to the US, and stops when only the website can change it", async () => {
  const { connect, sync } = await connected({
    availability: {
      availableInNewTerritories: false,
      available: ["CAN", "USA"],
    },
  });
  await sync();
  assert.deepEqual(connect.available(), ["USA"]);
  assert.ok(
    connect
      .writes()
      .includes("PATCH /v1/territoryAvailabilities/availability-CAN"),
  );
  assert.ok(!connect.writes().includes("POST /v2/appAvailabilities"));

  const joining = await connected({
    availability: { availableInNewTerritories: true, available: ["USA"] },
  });
  await assert.rejects(joining.sync(), {
    message:
      "App Store Connect has the app join new territories, which its API cannot change. Change it in Pricing and Availability in App Store Connect, then run this again.",
  });
});

test("the review information needs TestFlight's contact and a demo invitation that lasts", async () => {
  const { listing } = await connected();
  const soon = {
    ...review,
    invitation: {
      ...review.invitation,
      expiresAt: new Date(now + 20 * day).toISOString(),
    },
  };
  assert.throws(() => reviewNotes(listing, soon, now), {
    message:
      "The demo invitation has 12 signups and 20 days left, and the review notes need one that lasts 30 days. Reseed the demo circle on production (docs/running-screenr.md#demo-circle-for-apple-review), then run this again.",
  });
  const used = {
    ...review,
    invitation: { ...review.invitation, remaining: 0 },
  };
  assert.throws(() => reviewNotes(listing, used, now), {
    message: /has 0 signups and 90 days left/,
  });
  assert.throws(
    () =>
      reviewNotes(listing, { ...review, reviewer: "someone@example.com" }, now),
    {
      message:
        "Production's reviewer is someone@example.com, but the listing names review@screenr.club.",
    },
  );

  const missing = await connected({
    contact: {
      contactFirstName: "Pat",
      contactLastName: "Owner",
      contactPhone: null,
      contactEmail: "owner@example.com",
    },
  });
  await assert.rejects(missing.sync(), {
    message:
      "TestFlight's Test Information has no contactPhone, which the review information copies. Fill them in in App Store Connect, then run this again.",
  });

  // Without review details, the review information stays as it is.
  const without = await connected();
  await without.sync({ review: undefined });
  assert.equal(without.connect.reviewDetail(), undefined);
  assert.ok(
    without.lines.includes("==> Leaving the review information as it is"),
  );

  // An existing review detail changes only where it differs.
  const existing = await connected({
    reviewDetail: {
      ...fakeListing().contact,
      demoAccountName: "old@example.com",
    },
  });
  await existing.sync();
  assert.ok(
    existing.connect
      .writes()
      .includes("PATCH /v1/appStoreReviewDetails/review-1"),
  );
  assert.ok(
    existing.lines.includes(
      "==> Setting version 1.0's review information: demoAccountName, demoAccountPassword, demoAccountRequired, notes",
    ),
  );
});

test("the sync goes to the one editable version, or the one named", async () => {
  const none = await connected({
    versions: [
      {
        id: "version-1",
        versionString: "1.0",
        appVersionState: "READY_FOR_DISTRIBUTION",
      },
    ],
  });
  await assert.rejects(none.sync(), {
    message:
      "App Store Connect has no App Store version of Screenr to edit. Create the next version, which bin/appstore does, then run this again.",
  });
  const several = await connected({
    versions: [
      {
        id: "version-1",
        versionString: "1.1",
        appVersionState: "PREPARE_FOR_SUBMISSION",
      },
      {
        id: "version-2",
        versionString: "1.2",
        appVersionState: "DEVELOPER_REJECTED",
      },
    ],
  });
  await assert.rejects(several.sync(), {
    message:
      "App Store Connect has several editable App Store versions, 1.1, 1.2; name one with --version.",
  });
  await assert.rejects(several.sync({ version: "1.3" }), {
    message:
      "App Store Connect has no editable App Store version 1.3; it has 1.1, 1.2.",
  });
  await several.sync({ version: "1.1" });
  assert.ok(
    several.connect.writes().includes("PATCH /v1/appStoreVersions/version-1"),
  );
  assert.ok(
    !several.connect.writes().includes("PATCH /v1/appStoreVersions/version-2"),
  );
});

test("a URL App Store Connect stores with a trailing slash counts as unchanged", async () => {
  const { connect, sync } = await connected({ slashUrls: true });
  await sync();
  assert.equal(
    connect.localizations[0]!.attributes.marketingUrl,
    "https://screenr.club/",
  );
  connect.requests.length = 0;
  assert.deepEqual(await sync(), []);
});

test("production's review details come over SSH from the release's one-off script", async () => {
  const calls: [string, string[]][] = [];
  const answer =
    (stdout: string) => async (command: string, args: string[]) => {
      calls.push([command, args]);
      return { stdout };
    };
  assert.deepEqual(
    await productionReviewDetails(
      "root@host",
      answer(`${JSON.stringify(review)}\n`),
    ),
    review,
  );
  assert.deepEqual(calls, [
    [
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "root@host",
        "sh /usr/local/lib/screenr-deploy/run-release-script.sh /opt/screenr/current scripts/review-details.ts",
      ],
    ],
  ]);
  await assert.rejects(
    productionReviewDetails("-oProxyCommand=x", answer("")),
    {
      message: '"-oProxyCommand=x" is not an SSH destination.',
    },
  );
  await assert.rejects(
    productionReviewDetails(
      "root@host",
      answer(JSON.stringify({ ...review, signInCode: "12345" })),
    ),
    {
      message:
        /lack the reviewer, a six-digit sign-in code, or the demo invitation/,
    },
  );
  await assert.rejects(
    productionReviewDetails("root@host", async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr: "The demo circle has no demo invitation.\n",
      });
    }),
    {
      message:
        "Could not read the review details from root@host: The demo circle has no demo invitation.",
    },
  );
});

test("the command needs the production host unless it only reports", () => {
  assert.deepEqual(parseCommand(["--dry-run"]), {
    kind: "sync",
    dryRun: true,
    host: undefined,
    version: undefined,
  });
  assert.deepEqual(parseCommand(["--host", "root@host", "--version", "1.1"]), {
    kind: "sync",
    dryRun: false,
    host: "root@host",
    version: "1.1",
  });
  assert.deepEqual(parseCommand(["--screenshots"]), { kind: "screenshots" });
  assert.deepEqual(parseCommand(["--help"]), { kind: "help" });
  assert.throws(() => parseCommand([]), { message: /Pass --host/ });
  assert.throws(() => parseCommand(["--screenshots", "--dry-run"]), {
    message: "--screenshots takes no other options.",
  });
  assert.throws(() => parseCommand(["--dry-run", "--version", "1.0.1"]), {
    message: "1.0.1 is not an App Store version, such as 1.0, with one dot.",
  });
  assert.throws(() => parseCommand(["--dry-run", "extra"]));
});

test("the screenshots the last iOS check took replace the listing's", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenr-listing-take-"));
  try {
    const taken = join(directory, "ios/build/check/screenshots");
    const target = join(directory, "app-store/screenshots/APP_IPHONE_61");
    await mkdir(taken, { recursive: true });
    await mkdir(target, { recursive: true });
    const listing = JSON.parse(await listingSource());
    listing.screenshots = { APP_IPHONE_61: ["1-feed.png", "2-title.png"] };
    await writeFile(
      join(directory, "app-store/listing.json"),
      JSON.stringify(listing),
    );
    await writeFile(join(target, "old.png"), png(1206, 2622, "old"));
    await writeFile(join(taken, "1-feed.png"), png(1206, 2622, "feed"));
    await assert.rejects(takeScreenshots(directory), {
      message:
        "ios/build/check/screenshots has no 2-title.png. Run bin/check-ios, whose UI tests take the screenshots, then run this again.",
    });
    await writeFile(join(taken, "2-title.png"), png(1206, 2622, "title", 6));
    await assert.rejects(takeScreenshots(directory), {
      message: /has an alpha channel/,
    });
    await writeFile(join(taken, "2-title.png"), png(1206, 2622, "title"));
    assert.deepEqual(await takeScreenshots(directory), [
      "app-store/screenshots/APP_IPHONE_61/1-feed.png",
      "app-store/screenshots/APP_IPHONE_61/2-title.png",
    ]);
    // Files the listing no longer names leave with the old set.
    await assert.rejects(readFile(join(target, "old.png")));
    const { screenshots } = await readListing(directory);
    assert.equal(screenshots.APP_IPHONE_61!.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
