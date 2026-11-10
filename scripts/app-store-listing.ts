import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { appStoreConnect, credentialsFrom, findApp } from "./app-store-connect";
import {
  descriptionText,
  keywordsText,
  readOnly,
  syncListing,
} from "./app-store-listing-sync";

// bin/app-store-listing: brings the App Store listing in App Store Connect in
// line with app-store/listing.json and app-store/screenshots, under the App
// Store listing decision (docs/ios-app.md#app-store-listing--2026-11-09):
// the version's text, copyright, and screenshots; the app's name, subtitle,
// privacy policy, categories, age rating, content rights, and availability;
// and the review information, with the reviewer's sign-in code and the demo
// invitation read from production at run time. Each part changes only when
// it differs, so a rerun changes nothing, and --dry-run reports what would
// change. This file reads and checks the repository's listing and the review
// details; scripts/app-store-listing-sync.ts changes App Store Connect. See
// docs/running-screenr.md#app-store-listing.

const bundleId = "com.artisanalsoftware.Screenr";
export const listingFolder = "app-store";
const checkScreenshots = "ios/build/check/screenshots";
// How production runs a release's one-off scripts (docs/deployment.md).
const reviewDetailsCommand =
  "sh /usr/local/lib/screenr-deploy/run-release-script.sh /opt/screenr/current scripts/review-details.ts";
// A review can take days and a rejection more, so the demo invitation in the
// notes must outlast them. Reseeding the demo circle renews it.
const invitationDaysNeeded = 30;
const day = 86_400_000;

// App Store Connect's limits on the listing's text.
const limits = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  description: 4000,
  keywords: 100,
  notes: 4000,
};

// The screenshot sizes, in portrait, that App Store Connect accepts for each
// display type the listing fills. APP_IPHONE_61 is iPhone with Dynamic Island
// (medium display), the one iPhone size Apple requires.
export const screenshotSizes: Record<string, [number, number][]> = {
  APP_IPHONE_61: [
    [1206, 2622],
    [1179, 2556],
  ],
};

export type Listing = {
  locale: string;
  name: string;
  subtitle: string;
  promotionalText: string;
  // Paragraphs, which the App Store shows with a blank line between them.
  description: string[];
  keywords: string[];
  supportUrl: string;
  marketingUrl: string;
  privacyPolicyUrl: string;
  copyright: string;
  primaryCategory: string;
  secondaryCategory: string;
  contentRightsDeclaration:
    "USES_THIRD_PARTY_CONTENT" | "DOES_NOT_USE_THIRD_PARTY_CONTENT";
  availability: { territories: string[]; availableInNewTerritories: boolean };
  // The age rating questionnaire's answers, as App Store Connect names them.
  ageRating: Record<string, string | boolean>;
  review: { demoAccountName: string; notes: string[] };
  // Each display type's screenshots, in order, in app-store/screenshots/<type>.
  screenshots: Record<string, string[]>;
};

// The review notes name these, which come from production at run time.
const placeholders = ["{signInCode}", "{invitation}"];

const text = (value: unknown, name: string, limit?: number) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`The listing's ${name} must be text.`);
  if (limit && [...value].length > limit)
    throw new Error(
      `The listing's ${name} has ${[...value].length} characters; App Store Connect allows ${limit}.`,
    );
  return value;
};
const texts = (value: unknown, name: string) => {
  if (!Array.isArray(value) || !value.length)
    throw new Error(`The listing's ${name} must be a list of text.`);
  return value.map((item, index) => text(item, `${name}[${index}]`));
};
const https = (value: unknown, name: string) => {
  const url = text(value, name);
  if (new URL(url).protocol !== "https:")
    throw new Error(`The listing's ${name} must be an HTTPS URL.`);
  return url;
};

// Reads app-store/listing.json and checks it against App Store Connect's
// limits, so a bad listing stops before anything changes.
export function parseListing(source: string): Listing {
  const raw = JSON.parse(source) as Record<string, any>;
  const listing: Listing = {
    locale: text(raw.locale, "locale"),
    name: text(raw.name, "name", limits.name),
    subtitle: text(raw.subtitle, "subtitle", limits.subtitle),
    promotionalText: text(
      raw.promotionalText,
      "promotionalText",
      limits.promotionalText,
    ),
    description: texts(raw.description, "description"),
    keywords: texts(raw.keywords, "keywords"),
    supportUrl: https(raw.supportUrl, "supportUrl"),
    marketingUrl: https(raw.marketingUrl, "marketingUrl"),
    privacyPolicyUrl: https(raw.privacyPolicyUrl, "privacyPolicyUrl"),
    copyright: text(raw.copyright, "copyright"),
    primaryCategory: text(raw.primaryCategory, "primaryCategory"),
    secondaryCategory: text(raw.secondaryCategory, "secondaryCategory"),
    contentRightsDeclaration: raw.contentRightsDeclaration,
    availability: {
      territories: texts(
        raw.availability?.territories,
        "availability.territories",
      ),
      availableInNewTerritories: raw.availability?.availableInNewTerritories,
    },
    ageRating: raw.ageRating,
    review: {
      demoAccountName: text(
        raw.review?.demoAccountName,
        "review.demoAccountName",
      ),
      notes: texts(raw.review?.notes, "review.notes"),
    },
    screenshots: raw.screenshots,
  };
  text(descriptionText(listing), "description", limits.description);
  text(keywordsText(listing), "keywords", limits.keywords);
  if (listing.keywords.some((keyword) => keyword.includes(",")))
    throw new Error("The listing's keywords must not contain commas.");
  if (
    !["USES_THIRD_PARTY_CONTENT", "DOES_NOT_USE_THIRD_PARTY_CONTENT"].includes(
      listing.contentRightsDeclaration,
    )
  )
    throw new Error(
      "The listing's contentRightsDeclaration must be USES_THIRD_PARTY_CONTENT or DOES_NOT_USE_THIRD_PARTY_CONTENT.",
    );
  if (typeof listing.availability.availableInNewTerritories !== "boolean")
    throw new Error(
      "The listing's availability.availableInNewTerritories must be true or false.",
    );
  const answers = Object.entries(listing.ageRating ?? {});
  if (
    !answers.length ||
    answers.some(([, value]) => !["string", "boolean"].includes(typeof value))
  )
    throw new Error(
      "The listing's ageRating must answer each question with text or true or false.",
    );
  const notes = listing.review.notes.join("\n\n");
  for (const placeholder of placeholders)
    if (!notes.includes(placeholder))
      throw new Error(
        `The listing's review notes must include ${placeholder}.`,
      );
  const types = Object.entries(listing.screenshots ?? {});
  if (!types.length) throw new Error("The listing names no screenshots.");
  for (const [type, files] of types) {
    if (!screenshotSizes[type])
      throw new Error(
        `The listing's screenshots name ${type}, which has no known sizes. Known: ${Object.keys(screenshotSizes).join(", ")}.`,
      );
    texts(files, `screenshots.${type}`);
    if (files.length > 10)
      throw new Error(
        `App Store Connect takes at most 10 ${type} screenshots.`,
      );
  }
  return listing;
}

// A PNG's size, from its header, and whether it has an alpha channel, which
// App Store Connect refuses.
export function pngShape(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 33 ||
    signature.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  )
    return undefined;
  const colorType = bytes[25]!;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    // Gray with alpha and RGBA.
    alpha: colorType === 4 || colorType === 6,
  };
}

export type Screenshot = {
  fileName: string;
  bytes: Uint8Array;
  // App Store Connect's sourceFileChecksum: the file's MD5 in hex.
  checksum: string;
};

// Checks that a screenshot is a PNG of an accepted size without alpha.
function checkScreenshot(type: string, name: string, bytes: Uint8Array) {
  const shape = pngShape(bytes);
  if (!shape) throw new Error(`${name} is not a PNG.`);
  const sizes = screenshotSizes[type]!;
  if (
    !sizes.some(
      ([width, height]) => shape.width === width && shape.height === height,
    )
  )
    throw new Error(
      `${name} is ${shape.width} × ${shape.height}; App Store Connect takes ${type} screenshots of ${sizes.map(([width, height]) => `${width} × ${height}`).join(" or ")}.`,
    );
  if (shape.alpha)
    throw new Error(
      `${name} has an alpha channel, which App Store Connect refuses.`,
    );
}

// The listing and its screenshots, checked, from a checkout.
export async function readListing(root: string) {
  const folder = join(root, listingFolder);
  const listing = parseListing(
    await readFile(join(folder, "listing.json"), "utf8"),
  );
  const screenshots: Record<string, Screenshot[]> = {};
  for (const [type, files] of Object.entries(listing.screenshots)) {
    screenshots[type] = [];
    for (const fileName of files) {
      const path = join(listingFolder, "screenshots", type, fileName);
      const bytes = await readFile(join(root, path));
      checkScreenshot(type, path, bytes);
      screenshots[type].push({
        fileName,
        bytes,
        checksum: createHash("md5").update(bytes).digest("hex"),
      });
    }
    const unique = new Set(screenshots[type].map(({ checksum }) => checksum));
    if (unique.size !== files.length)
      throw new Error(`Two of the ${type} screenshots are the same file.`);
  }
  return { listing, screenshots };
}

// Replaces the listing's screenshots with the ones the last bin/check-ios run
// took (ios/ScreenrUITests/AppStoreScreenshotTests.swift), after checking
// them, and returns the files it copied.
export async function takeScreenshots(root: string) {
  const listing = parseListing(
    await readFile(join(root, listingFolder, "listing.json"), "utf8"),
  );
  const source = join(root, checkScreenshots);
  const taken = new Set(await readdir(source).catch(() => []));
  const copied: string[] = [];
  for (const [type, files] of Object.entries(listing.screenshots)) {
    const missing = files.filter((file) => !taken.has(file));
    if (missing.length)
      throw new Error(
        `${checkScreenshots} has no ${missing.join(", ")}. Run bin/check-ios, whose UI tests take the screenshots, then run this again.`,
      );
    for (const file of files)
      checkScreenshot(
        type,
        join(checkScreenshots, file),
        await readFile(join(source, file)),
      );
    const target = join(root, listingFolder, "screenshots", type);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const file of files) {
      await copyFile(join(source, file), join(target, file));
      copied.push(join(listingFolder, "screenshots", type, file));
    }
  }
  return copied;
}

// What the review information needs from production: the line
// scripts/review-details.ts prints.
export type ReviewDetails = {
  reviewer: string;
  signInCode: string;
  invitation: { url: string; expiresAt: string; remaining: number };
};

export function parseReviewDetails(line: string): ReviewDetails {
  let details: ReviewDetails;
  try {
    details = JSON.parse(line) as ReviewDetails;
  } catch {
    throw new Error("Production's review details are not JSON.");
  }
  const { reviewer, signInCode, invitation } = details ?? {};
  if (
    typeof reviewer !== "string" ||
    typeof signInCode !== "string" ||
    !/^[0-9]{6}$/.test(signInCode) ||
    typeof invitation?.url !== "string" ||
    !/^https:\/\/[^/]+\/join\/[A-Za-z0-9_-]{43}$/.test(invitation.url) ||
    Number.isNaN(Date.parse(invitation.expiresAt)) ||
    !Number.isInteger(invitation.remaining)
  )
    throw new Error(
      "Production's review details lack the reviewer, a six-digit sign-in code, or the demo invitation.",
    );
  return { reviewer, signInCode, invitation };
}

// Reads the review details from production over SSH as the owner, through
// the release's one-off script runner. The code passes only through this
// process.
export async function productionReviewDetails(
  host: string,
  run: (command: string, args: string[]) => Promise<{ stdout: string }> = (
    command,
    args,
  ) => promisify(execFile)(command, args, { timeout: 5 * 60_000 }),
) {
  if (!host || host.startsWith("-"))
    throw new Error(`${JSON.stringify(host)} is not an SSH destination.`);
  let stdout: string;
  try {
    ({ stdout } = await run("ssh", [
      "-o",
      "BatchMode=yes",
      host,
      reviewDetailsCommand,
    ]));
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    throw new Error(
      `Could not read the review details from ${host}: ${stderr?.trim() || (error as Error).message}`,
    );
  }
  return parseReviewDetails(stdout.trim());
}

// The review notes, with the sign-in code and the demo invitation in place.
export function reviewNotes(
  listing: Listing,
  details: ReviewDetails,
  now = Date.now(),
) {
  if (details.reviewer !== listing.review.demoAccountName)
    throw new Error(
      `Production's reviewer is ${details.reviewer}, but the listing names ${listing.review.demoAccountName}.`,
    );
  const { invitation } = details;
  const left = (Date.parse(invitation.expiresAt) - now) / day;
  if (invitation.remaining < 1 || left < invitationDaysNeeded)
    throw new Error(
      `The demo invitation has ${invitation.remaining} signups and ${Math.max(0, Math.floor(left))} days left, and the review notes need one that lasts ${invitationDaysNeeded} days. Reseed the demo circle on production (docs/running-screenr.md#demo-circle-for-apple-review), then run this again.`,
    );
  const notes = listing.review.notes
    .join("\n\n")
    .replaceAll("{signInCode}", details.signInCode)
    .replaceAll("{invitation}", invitation.url);
  text(notes, "review notes", limits.notes);
  return notes;
}

export type Command =
  | { kind: "help" }
  | { kind: "screenshots" }
  | { kind: "sync"; dryRun: boolean; host?: string; version?: string };

export const usage = `Usage: bin/app-store-listing [--dry-run] [--host HOST] [--version VERSION]
       bin/app-store-listing --screenshots

Brings Screenr's App Store listing in App Store Connect in line with
app-store/listing.json and app-store/screenshots: the version's text,
copyright, and screenshots; the app's name, subtitle, privacy policy,
categories, age rating, content rights, and availability; and the review
information. A rerun changes nothing that already matches.

  --host HOST     The production host, such as root@YOUR_SSH_HOST, whose
                  REVIEW_SIGN_IN_CODE and demo invitation go in the review
                  information, read over SSH. Required unless --dry-run.
  --version X     The App Store version to update. By default, the one
                  version App Store Connect lets you edit.
  --dry-run       Report what would change, and change nothing. Without
                  --host, it leaves out the review information.
  --screenshots   Copy the screenshots that the last bin/check-ios run took
                  into app-store/screenshots, and change nothing else.

The App Store Connect API key comes from ASC_KEY_PATH, ASC_KEY_ID, and
ASC_ISSUER_ID. See docs/running-screenr.md#app-store-listing.`;

export function parseCommand(args: string[]): Command {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean" },
      host: { type: "string" },
      version: { type: "string" },
      screenshots: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return { kind: "help" };
  if (values.screenshots) {
    if (values["dry-run"] || values.host || values.version)
      throw new Error("--screenshots takes no other options.");
    return { kind: "screenshots" };
  }
  if (!values["dry-run"] && !values.host)
    throw new Error(
      "Pass --host with the production host, whose review details the listing needs, or --dry-run.",
    );
  if (values.version !== undefined && !/^\d+\.\d+$/.test(values.version))
    throw new Error(
      `${values.version} is not an App Store version, such as 1.0, with one dot.`,
    );
  return {
    kind: "sync",
    dryRun: Boolean(values["dry-run"]),
    host: values.host,
    version: values.version,
  };
}

async function main(command: Command, root: string) {
  if (command.kind === "help") return console.log(usage);
  if (command.kind === "screenshots") {
    for (const file of await takeScreenshots(root))
      console.log(`==> Copied ${file}`);
    console.log("Review the screenshots, then commit them with the listing.");
    return;
  }
  const { listing, screenshots } = await readListing(root);
  const details = command.host
    ? await productionReviewDetails(command.host)
    : undefined;
  const review = details && {
    signInCode: details.signInCode,
    notes: reviewNotes(listing, details),
  };
  const client = await appStoreConnect(credentialsFrom(process.env));
  const api = command.dryRun ? readOnly(client) : client;
  const app = await findApp(api, bundleId);
  const changes = await syncListing(
    api,
    app,
    { listing, screenshots, review, version: command.version },
    {
      apply: !command.dryRun,
      log: (line) => console.log(line),
      sleep: (milliseconds) =>
        new Promise((done) => setTimeout(done, milliseconds)),
      timeout: 10 * 60_000,
    },
  );
  console.log(
    changes.length
      ? command.dryRun
        ? `${changes.length} parts of the listing differ; nothing changed.`
        : `Changed ${changes.length} parts of the listing.`
      : "The listing in App Store Connect matches the repository's.",
  );
}

if (process.argv[1]?.endsWith("scripts/app-store-listing.ts")) {
  try {
    await main(
      parseCommand(process.argv.slice(2)),
      fileURLToPath(new URL("..", import.meta.url)),
    );
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
