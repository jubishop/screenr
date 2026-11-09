import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applePrivateKey, signAppleJWT } from "../src/server/apple-jwt";

// The App Store Connect API calls behind bin/testflight: find the build the
// external group already tests, clear the way for Beta App Review, wait for
// an uploaded build to finish processing, set its What to Test notes, add it
// to the tester groups, and submit it for Beta App Review.

const origin = "https://api.appstoreconnect.apple.com";
// Apple refuses tokens that expire more than 20 minutes after they are issued.
const tokenLifetime = 15 * 60;
export const externalGroupName = "Public testers";
const internalGroupName = "Screenr team";

export type Environment = Record<string, string | undefined>;
export type Credentials = { keyPath: string; keyId: string; issuerId: string };

// The API key's .p8 file, key ID, and issuer ID, which xcodebuild also uses.
export function credentialsFrom(env: Environment): Credentials {
  const names = ["ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID"];
  const missing = names.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(
      `Set ${missing.join(", ")} to the App Store Connect API key's .p8 file, key ID, and issuer ID.`,
    );
  return {
    keyPath: resolve(env.ASC_KEY_PATH!),
    keyId: env.ASC_KEY_ID!,
    issuerId: env.ASC_ISSUER_ID!,
  };
}

type Link = { data?: { type: string; id: string } };
type Resource<Attributes> = {
  type?: string;
  id: string;
  attributes: Attributes;
  relationships?: Record<string, Link>;
};
type One<Attributes> = {
  data: Resource<Attributes>;
  included?: Resource<Record<string, unknown>>[];
};
type Many<Attributes> = {
  data: Resource<Attributes>[];
  included?: Resource<Record<string, unknown>>[];
  links?: { next?: string };
};

// Apple's error documents list a title and detail for each problem.
function problem(text: string) {
  try {
    const { errors } = JSON.parse(text) as {
      errors?: { title?: string; detail?: string }[];
    };
    if (errors?.length)
      return errors
        .map(({ title, detail }) => [title, detail].filter(Boolean).join(": "))
        .join("; ");
  } catch {
    // Not JSON; report the text itself.
  }
  return text.slice(0, 500) || "no details";
}

// Each request signs a new token, so a long wait never outlives one. A path
// may also be a full API URL, such as a list's link to its next page.
export async function appStoreConnect(
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const key = applePrivateKey(await readFile(credentials.keyPath, "utf8"));
  async function request<T>(method: string, path: string, body?: unknown) {
    const url = new URL(path, origin);
    if (url.origin !== origin)
      throw new Error(`Refusing to send an App Store Connect token to ${url}.`);
    const issuedAt = Math.floor(now() / 1000);
    const token = signAppleJWT(
      key,
      credentials.keyId,
      {
        iss: credentials.issuerId,
        iat: issuedAt,
        exp: issuedAt + tokenLifetime,
        aud: "appstoreconnect-v1",
      },
      { typ: "JWT" },
    );
    const response = await fetcher(url.href, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `App Store Connect ${method} ${url.pathname} failed with ${response.status}: ${problem(text)}`,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  };
}

export type AppStoreConnect = Awaited<ReturnType<typeof appStoreConnect>>;
export type App = { id: string; primaryLocale: string };
export type Release = { version: string; build: number; notes: string };

export type Waiting = {
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
  timeout: number;
  interval?: number;
};

const query = (path: string, parameters: Record<string, string>) =>
  `${path}?${new URLSearchParams(parameters)}`;

export async function findApp(
  api: AppStoreConnect,
  bundleId: string,
): Promise<App> {
  const [app] = (
    await api.get<Many<{ primaryLocale: string }>>(
      query("/v1/apps", {
        "filter[bundleId]": bundleId,
        "fields[apps]": "bundleId,primaryLocale",
      }),
    )
  ).data;
  if (!app)
    throw new Error(`No App Store Connect app has the bundle ID ${bundleId}.`);
  return { id: app.id, primaryLocale: app.attributes.primaryLocale };
}

type Group = {
  name: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
};

async function betaGroups(api: AppStoreConnect, app: string) {
  return (
    await api.get<Many<Group>>(
      query(`/v1/apps/${app}/betaGroups`, {
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
        limit: "200",
      }),
    )
  ).data;
}

const isExternal = ({ attributes }: Resource<Group>) =>
  attributes.name === externalGroupName && !attributes.isInternalGroup;

// A build with its Beta App Review state for external testers.
type BetaBuild = {
  id: string;
  build: number;
  expired: boolean;
  externalState: string | undefined;
};

const betaFields = {
  include: "buildBetaDetail",
  "fields[builds]": "version,expired,buildBetaDetail",
  "fields[buildBetaDetails]": "externalBuildState",
};

function betaBuild(
  {
    id,
    attributes,
    relationships,
  }: Resource<{ version: string; expired: boolean }>,
  included: Resource<Record<string, unknown>>[] = [],
): BetaBuild {
  const detail = relationships?.buildBetaDetail?.data?.id;
  const state = included.find(
    (resource) =>
      resource.type === "buildBetaDetails" && resource.id === detail,
  )?.attributes.externalBuildState;
  return {
    id,
    build: Number(attributes.version),
    expired: attributes.expired,
    externalState: typeof state === "string" ? state : undefined,
  };
}

// Every iOS build that matches the filters, following Apple's page links.
async function* betaBuilds(
  api: AppStoreConnect,
  filters: Record<string, string>,
) {
  let path: string | undefined = query("/v1/builds", {
    ...filters,
    "filter[preReleaseVersion.platform]": "IOS",
    ...betaFields,
  });
  while (path) {
    const page: Many<{ version: string; expired: boolean }> =
      await api.get(path);
    for (const build of page.data) yield betaBuild(build, page.included);
    path = page.links?.next;
  }
}

async function refreshed(api: AppStoreConnect, build: string) {
  const { data, included } = await api.get<
    One<{ version: string; expired: boolean }>
  >(query(`/v1/builds/${build}`, betaFields));
  return betaBuild(data, included);
}

// The build number testers in the external group have: the newest build in
// it that Apple lists as in testing. A build still waiting for Beta App
// Review, or one that expired before approval, never reached them.
export async function testedBuild(api: AppStoreConnect, app: string) {
  const group = (await betaGroups(api, app)).find(isExternal);
  if (!group) return undefined;
  for await (const build of betaBuilds(api, {
    "filter[betaGroups]": group.id,
    "filter[expired]": "false",
    sort: "-uploadedDate",
    limit: "50",
  }))
    if (build.externalState === "IN_BETA_TESTING") return build.build;
  return undefined;
}

const reviewing = ["WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW"];

// Apple reviews one build of a version at a time. "ready" means this build
// can go to Beta App Review once it is processed; "next-version" means Apple
// is already reviewing an older build of the version, which the release
// keeps, so the release has to move to the next patch version. With
// expireWaiting, an older build that still only waits for review is expired
// so that this build replaces its submission; without it, such a build is
// left alone, as a check before the archive.
export async function prepareReview(
  api: AppStoreConnect,
  app: string,
  { version, build }: { version: string; build: number },
  {
    expireWaiting,
    log,
  }: { expireWaiting: boolean; log: (line: string) => void },
): Promise<"ready" | "next-version"> {
  const builds: BetaBuild[] = [];
  for await (const found of betaBuilds(api, {
    "filter[app]": app,
    "filter[preReleaseVersion.version]": version,
    "filter[expired]": "false",
    limit: "200",
  }))
    builds.push(found);
  const target = builds.find((found) => found.build === build);
  if (target && target.externalState !== "READY_FOR_BETA_SUBMISSION")
    return "ready";
  const conflicts = builds.filter(
    (found) =>
      found.build !== build && reviewing.includes(found.externalState ?? ""),
  );
  if (!conflicts.length) return "ready";
  const label = (found: BetaBuild) => `${version} (${found.build})`;
  const older = conflicts[0]!;
  if (conflicts.length > 1 || older.build > build)
    throw new Error(
      `Cannot replace the Beta App Review submissions of ${conflicts
        .map((found) => `${label(found)}, ${found.externalState}`)
        .join("; ")}. Expected one older build of ${version}.`,
    );
  const nextVersion = () => {
    log(
      `==> Apple is reviewing ${label(older)}, so this release keeps that review and moves to the next patch version`,
    );
    return "next-version" as const;
  };
  if (older.externalState === "IN_BETA_REVIEW") return nextVersion();
  if (!expireWaiting) return "ready";
  const current = await refreshed(api, older.id);
  if (current.expired) return "ready";
  if (current.externalState === "IN_BETA_REVIEW") return nextVersion();
  if (current.externalState !== "WAITING_FOR_BETA_REVIEW")
    throw new Error(
      `${label(older)} is no longer waiting for Beta App Review but ${current.externalState}. Run bin/testflight again.`,
    );
  log(
    `==> Expiring ${label(older)}, which is waiting for Beta App Review, so that ${version} (${build}) replaces its submission`,
  );
  try {
    await api.patch(`/v1/builds/${older.id}`, {
      data: { type: "builds", id: older.id, attributes: { expired: true } },
    });
  } catch (error) {
    if ((await refreshed(api, older.id)).externalState === "IN_BETA_REVIEW")
      return nextVersion();
    throw error;
  }
  const expired = await refreshed(api, older.id);
  if (!expired.expired) {
    if (expired.externalState === "IN_BETA_REVIEW") return nextVersion();
    throw new Error(
      `App Store Connect has not confirmed that ${label(older)} expired, so nothing was submitted in its place. Run bin/testflight again.`,
    );
  }
  return "ready";
}

function duration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds % 60) return `${seconds} seconds`;
  return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
}

async function processedBuild(
  api: AppStoreConnect,
  app: string,
  { version, build }: Release,
  { sleep, log, timeout, interval = 30_000 }: Waiting,
) {
  const label = `${version} (${build})`;
  const path = query("/v1/builds", {
    "filter[app]": app,
    "filter[version]": String(build),
    "filter[preReleaseVersion.version]": version,
    "fields[builds]":
      "version,processingState,usesNonExemptEncryption,buildBetaDetail",
    include: "buildBetaDetail",
    "fields[buildBetaDetails]": "externalBuildState",
    limit: "1",
  });
  log(`==> Waiting for App Store Connect to process ${label}`);
  for (let waited = 0; ; waited += interval) {
    const page = await api.get<
      Many<{
        processingState: string;
        usesNonExemptEncryption: boolean | null;
      }>
    >(path);
    const [found] = page.data;
    const state = found?.attributes.processingState;
    if (state === "FAILED" || state === "INVALID")
      throw new Error(
        `App Store Connect marked ${label} ${state}. Check the build's email from Apple and TestFlight's Build Uploads.`,
      );
    // TestFlight processes a valid build for its testers a little longer.
    const testing =
      found &&
      page.included?.find(
        ({ type, id }) =>
          type === "buildBetaDetails" &&
          id === found.relationships?.buildBetaDetail?.data?.id,
      )?.attributes.externalBuildState;
    if (found && state === "VALID" && testing !== "PROCESSING") {
      // Info.plist's ITSAppUsesNonExemptEncryption answers export compliance.
      if (found.attributes.usesNonExemptEncryption === null)
        throw new Error(
          `${label} is missing export compliance. Answer it in TestFlight in App Store Connect, then run bin/testflight --distribute-only.`,
        );
      return found.id;
    }
    if (waited + interval > timeout)
      throw new Error(
        `${label} did not finish processing in ${duration(timeout)}. Check TestFlight's Build Uploads in App Store Connect; while it is still processing, run bin/testflight --distribute-only to keep waiting. SCREENR_TESTFLIGHT_TIMEOUT_SECONDS sets a longer wait.`,
      );
    await sleep(interval);
  }
}

async function setWhatToTest(
  api: AppStoreConnect,
  build: string,
  locale: string,
  notes: string,
) {
  const existing = (
    await api.get<Many<{ locale: string }>>(
      query(`/v1/builds/${build}/betaBuildLocalizations`, {
        "fields[betaBuildLocalizations]": "locale,whatsNew",
      }),
    )
  ).data.find(({ attributes }) => attributes.locale === locale);
  const type = "betaBuildLocalizations";
  if (existing)
    await api.patch(`/v1/betaBuildLocalizations/${existing.id}`, {
      data: { type, id: existing.id, attributes: { whatsNew: notes } },
    });
  else
    await api.post("/v1/betaBuildLocalizations", {
      data: {
        type,
        attributes: { locale, whatsNew: notes },
        relationships: { build: { data: { type: "builds", id: build } } },
      },
    });
}

// The external group, created if needed, and an internal group that does not
// already receive every build. Testers in a group see the build once it is
// processed, or, for an external group, once Beta App Review approves it.
async function assignGroups(
  api: AppStoreConnect,
  app: string,
  build: string,
  log: (line: string) => void,
) {
  const groups = await betaGroups(api, app);
  const holding = async () =>
    (
      await api.get<Many<{ name: string }>>(
        query("/v1/betaGroups", {
          "filter[builds]": build,
          "fields[betaGroups]": "name",
          limit: "200",
        }),
      )
    ).data;
  let external = groups.find(isExternal);
  if (!external) {
    log(`==> Creating the external group "${externalGroupName}"`);
    try {
      external = (
        await api.post<One<Group>>("/v1/betaGroups", {
          data: {
            type: "betaGroups",
            attributes: {
              name: externalGroupName,
              isInternalGroup: false,
              publicLinkEnabled: false,
              feedbackEnabled: true,
            },
            relationships: { app: { data: { type: "apps", id: app } } },
          },
        })
      ).data;
    } catch (error) {
      throw new Error(
        `Could not create the external group "${externalGroupName}": ${(error as Error).message} Create it in TestFlight in App Store Connect, then run bin/testflight --distribute-only.`,
      );
    }
  }
  const internal = groups.find(
    ({ attributes }) =>
      attributes.name === internalGroupName && attributes.isInternalGroup,
  );
  const targets = [external];
  if (internal && !internal.attributes.hasAccessToAllBuilds)
    targets.push(internal);
  const already = new Set((await holding()).map(({ id }) => id));
  for (const group of targets.filter(({ id }) => !already.has(id))) {
    log(`==> Adding the build to "${group.attributes.name}"`);
    await api.post(`/v1/betaGroups/${group.id}/relationships/builds`, {
      data: [{ type: "builds", id: build }],
    });
  }
  const confirmed = await holding();
  if (!confirmed.some(({ id }) => id === external.id))
    throw new Error(
      `App Store Connect does not list the build in "${externalGroupName}". Run bin/testflight --distribute-only to retry.`,
    );
  const automatic = groups.filter(
    ({ attributes }) =>
      attributes.isInternalGroup && attributes.hasAccessToAllBuilds,
  );
  return [
    ...new Set(
      [...confirmed, ...automatic].map(({ attributes }) => attributes.name),
    ),
  ].sort();
}

// The states of a build that Beta App Review has, or has passed.
const submitted = [
  "WAITING_FOR_BETA_REVIEW",
  "IN_BETA_REVIEW",
  "BETA_APPROVED",
  "READY_FOR_BETA_TESTING",
  "IN_BETA_TESTING",
];

const externalState = async (api: AppStoreConnect, build: string) =>
  (
    await api.get<One<{ externalBuildState: string }>>(
      query(`/v1/builds/${build}/buildBetaDetail`, {
        "fields[buildBetaDetails]": "externalBuildState",
      }),
    )
  ).data.attributes.externalBuildState;

export type Distribution =
  | {
      nextVersion: false;
      build: string;
      groups: string[];
      externalState: string;
    }
  | { nextVersion: true };

// Brings an uploaded build to testers and submits it for Beta App Review.
// Every step can run again safely, which is how a rerun of bin/testflight
// resumes. When Apple is already reviewing an older build of the version, the
// build stays uploaded but unsubmitted, and the result asks for the next
// patch version.
export async function distribute(
  api: AppStoreConnect,
  app: App,
  release: Release,
  waiting: Waiting,
): Promise<Distribution> {
  const { log } = waiting;
  const build = await processedBuild(api, app.id, release, waiting);
  log("==> Setting What to Test");
  await setWhatToTest(api, build, app.primaryLocale, release.notes);
  const groups = await assignGroups(api, app.id, build, log);
  let state = await externalState(api, build);
  if (state === "READY_FOR_BETA_SUBMISSION") {
    const review = { expireWaiting: true, log };
    if ((await prepareReview(api, app.id, release, review)) !== "ready")
      return { nextVersion: true };
    log("==> Submitting the build for Beta App Review");
    try {
      await api.post("/v1/betaAppReviewSubmissions", {
        data: {
          type: "betaAppReviewSubmissions",
          relationships: { build: { data: { type: "builds", id: build } } },
        },
      });
    } catch (error) {
      if (!/another build is in review/i.test((error as Error).message))
        throw error;
      log(`Apple refused the submission: ${(error as Error).message}`);
      const recheck = { expireWaiting: false, log };
      if ((await prepareReview(api, app.id, release, recheck)) !== "ready")
        return { nextVersion: true };
      throw new Error(
        "Apple still reports another build in Beta App Review. Check TestFlight in App Store Connect, then run bin/testflight --distribute-only.",
      );
    }
    state = await externalState(api, build);
  }
  if (!submitted.includes(state))
    throw new Error(
      `The build is in "${externalGroupName}", but external testing needs attention: it is ${state}. Check TestFlight in App Store Connect.`,
    );
  return { nextVersion: false, build, groups, externalState: state };
}
