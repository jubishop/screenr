import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applePrivateKey, signAppleJWT } from "../src/server/apple-jwt";

// The App Store Connect API calls behind bin/ios-testflight: wait for an
// uploaded build to finish processing, set its What to Test notes, add it to
// the tester groups, and, only on request, submit it for Beta App Review.

const origin = "https://api.appstoreconnect.apple.com";
// Apple refuses tokens that expire more than 20 minutes after they are issued.
const tokenLifetime = 15 * 60;
const externalGroupName = "Public testers";
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

type Resource<Attributes> = { id: string; attributes: Attributes };
type One<Attributes> = { data: Resource<Attributes> };
type Many<Attributes> = { data: Resource<Attributes>[] };

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

// Each request signs a new token, so a long wait never outlives one.
export async function appStoreConnect(
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const key = applePrivateKey(await readFile(credentials.keyPath, "utf8"));
  async function request<T>(method: string, path: string, body?: unknown) {
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
    const response = await fetcher(`${origin}${path}`, {
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
        `App Store Connect ${method} ${path.split("?")[0]} failed with ${response.status}: ${problem(text)}`,
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

export type Release = {
  bundleId: string;
  version: string;
  build: number;
  notes: string;
  submitReview: boolean;
};

export type Waiting = {
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
  timeout?: number;
  interval?: number;
};

const query = (path: string, parameters: Record<string, string>) =>
  `${path}?${new URLSearchParams(parameters)}`;

async function processedBuild(
  api: AppStoreConnect,
  app: string,
  { version, build }: Release,
  { sleep, log, timeout = 60 * 60_000, interval = 30_000 }: Waiting,
) {
  const label = `${version} (${build})`;
  const path = query("/v1/builds", {
    "filter[app]": app,
    "filter[version]": String(build),
    "filter[preReleaseVersion.version]": version,
    "fields[builds]": "version,processingState,usesNonExemptEncryption",
    limit: "1",
  });
  log(`==> Waiting for App Store Connect to process ${label}`);
  for (let waited = 0; ; waited += interval) {
    const [found] = (
      await api.get<
        Many<{
          processingState: string;
          usesNonExemptEncryption: boolean | null;
        }>
      >(path)
    ).data;
    const state = found?.attributes.processingState;
    if (state === "FAILED" || state === "INVALID")
      throw new Error(
        `App Store Connect marked ${label} ${state}. Check the build's email from Apple and TestFlight's Build Uploads.`,
      );
    if (found && state === "VALID") {
      // Info.plist's ITSAppUsesNonExemptEncryption answers export compliance.
      if (found.attributes.usesNonExemptEncryption === null)
        throw new Error(
          `${label} is missing export compliance. Answer it in TestFlight in App Store Connect, then run bin/ios-testflight --distribute-only.`,
        );
      return found.id;
    }
    if (waited + interval > timeout)
      throw new Error(
        `${label} did not finish processing in ${Math.round(timeout / 60_000)} minutes. Run bin/ios-testflight --distribute-only to keep waiting.`,
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

type Group = {
  name: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
};

// The external group, created if needed, and an internal group that does not
// already receive every build. Testers in a group see the build once it is
// processed, or, for an external group, once Beta App Review approves it.
async function assignGroups(
  api: AppStoreConnect,
  app: string,
  build: string,
  log: (line: string) => void,
) {
  const groups = (
    await api.get<Many<Group>>(
      query(`/v1/apps/${app}/betaGroups`, {
        "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds",
        limit: "200",
      }),
    )
  ).data;
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
  let external = groups.find(
    ({ attributes }) =>
      attributes.name === externalGroupName && !attributes.isInternalGroup,
  );
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
        `Could not create the external group "${externalGroupName}": ${(error as Error).message} Create it in TestFlight in App Store Connect, then run bin/ios-testflight --distribute-only.`,
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
      `App Store Connect does not list the build in "${externalGroupName}". Run bin/ios-testflight --distribute-only to retry.`,
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

async function submitForReview(
  api: AppStoreConnect,
  build: string,
  log: (line: string) => void,
) {
  const state = await externalState(api, build);
  if (submitted.includes(state)) return;
  if (state !== "READY_FOR_BETA_SUBMISSION")
    throw new Error(
      `The build cannot go to Beta App Review while it is ${state}.`,
    );
  log("==> Submitting the build for Beta App Review");
  await api.post("/v1/betaAppReviewSubmissions", {
    data: {
      type: "betaAppReviewSubmissions",
      relationships: { build: { data: { type: "builds", id: build } } },
    },
  });
}

// Brings an uploaded build to testers. Every step can run again safely, which
// is how bin/ios-testflight --distribute-only retries.
export async function distribute(
  api: AppStoreConnect,
  release: Release,
  waiting: Waiting,
) {
  const [app] = (
    await api.get<Many<{ primaryLocale: string }>>(
      query("/v1/apps", {
        "filter[bundleId]": release.bundleId,
        "fields[apps]": "bundleId,primaryLocale",
      }),
    )
  ).data;
  if (!app)
    throw new Error(
      `No App Store Connect app has the bundle ID ${release.bundleId}.`,
    );
  const build = await processedBuild(api, app.id, release, waiting);
  waiting.log("==> Setting What to Test");
  await setWhatToTest(api, build, app.attributes.primaryLocale, release.notes);
  const groups = await assignGroups(api, app.id, build, waiting.log);
  if (release.submitReview) await submitForReview(api, build, waiting.log);
  return { build, groups, externalState: await externalState(api, build) };
}
