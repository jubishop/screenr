import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appStoreConnect,
  credentialsFrom,
  distribute,
} from "../../scripts/app-store-connect";

type Recorded = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
  authorization: string;
};
type Group = {
  id: string;
  name: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
};

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const notFound = () =>
  json(404, {
    errors: [{ status: "404", title: "Not found", detail: "No such route." }],
  });

// An in-memory App Store Connect with one app and one uploaded build, 1.0 (4).
// Each listed processing state answers one poll of the builds list; undefined
// means the build has not appeared yet.
function fakeConnect(
  options: {
    processing?: (string | undefined)[];
    localization?: string;
    groups?: Group[];
    createGroup?: () => Response;
    externalState?: string;
  } = {},
) {
  const requests: Recorded[] = [];
  const processing = [...(options.processing ?? ["VALID"])];
  const groups = [...(options.groups ?? [])];
  const builds = new Set<string>();
  const localizations: { id: string; locale: string; whatsNew: string }[] =
    options.localization === undefined
      ? []
      : [{ id: "loc-1", locale: "en-US", whatsNew: options.localization }];
  let externalState = options.externalState ?? "READY_FOR_BETA_SUBMISSION";
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      search: url.searchParams,
      body,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    });
    assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
    const filter = (name: string) => url.searchParams.get(`filter[${name}]`);
    const route = `${method} ${url.pathname}`;
    if (route === "GET /v1/apps" && filter("bundleId"))
      return json(200, {
        data: [
          {
            type: "apps",
            id: "app-1",
            attributes: {
              bundleId: filter("bundleId"),
              primaryLocale: "en-US",
            },
          },
        ],
      });
    if (route === "GET /v1/builds") {
      assert.equal(filter("app"), "app-1");
      if (
        filter("version") !== "4" ||
        filter("preReleaseVersion.version") !== "1.0"
      )
        return json(200, { data: [] });
      const state = processing.length > 1 ? processing.shift() : processing[0];
      return json(200, {
        data:
          state === undefined
            ? []
            : [
                {
                  type: "builds",
                  id: "build-4",
                  attributes: {
                    version: "4",
                    processingState: state,
                    usesNonExemptEncryption: false,
                  },
                },
              ],
      });
    }
    if (route === "GET /v1/builds/build-4/betaBuildLocalizations")
      return json(200, {
        data: localizations.map(({ id, ...attributes }) => ({
          type: "betaBuildLocalizations",
          id,
          attributes,
        })),
      });
    if (route === "POST /v1/betaBuildLocalizations") {
      assert.equal(body.data.relationships.build.data.id, "build-4");
      const created = { id: "loc-new", ...body.data.attributes };
      localizations.push(created);
      return json(201, {
        data: { type: "betaBuildLocalizations", id: created.id },
      });
    }
    if (
      method === "PATCH" &&
      url.pathname.startsWith("/v1/betaBuildLocalizations/")
    ) {
      const localization = localizations.find(
        ({ id }) => url.pathname === `/v1/betaBuildLocalizations/${id}`,
      );
      if (!localization) return notFound();
      assert.equal(body.data.id, localization.id);
      localization.whatsNew = body.data.attributes.whatsNew;
      return json(200, {
        data: { type: "betaBuildLocalizations", id: localization.id },
      });
    }
    if (route === "GET /v1/apps/app-1/betaGroups")
      return json(200, {
        data: groups.map(({ id, ...attributes }) => ({
          type: "betaGroups",
          id,
          attributes,
        })),
      });
    if (route === "POST /v1/betaGroups") {
      const refused = options.createGroup?.();
      if (refused) return refused;
      assert.equal(body.data.relationships.app.data.id, "app-1");
      const group = {
        id: "group-new",
        hasAccessToAllBuilds: false,
        ...body.data.attributes,
      };
      groups.push(group);
      return json(201, {
        data: {
          type: "betaGroups",
          id: group.id,
          attributes: body.data.attributes,
        },
      });
    }
    if (route === "GET /v1/betaGroups" && filter("builds") === "build-4")
      return json(200, {
        data: groups
          .filter(({ id }) => builds.has(id))
          .map(({ id, name }) => ({
            type: "betaGroups",
            id,
            attributes: { name },
          })),
      });
    const added = url.pathname.match(
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds$/,
    );
    if (method === "POST" && added) {
      assert.deepEqual(body, { data: [{ type: "builds", id: "build-4" }] });
      builds.add(added[1]!);
      return json(204);
    }
    if (route === "GET /v1/builds/build-4/buildBetaDetail")
      return json(200, {
        data: {
          type: "buildBetaDetails",
          id: "build-4",
          attributes: {
            internalBuildState: "IN_BETA_TESTING",
            externalBuildState: externalState,
          },
        },
      });
    if (route === "POST /v1/betaAppReviewSubmissions") {
      assert.equal(body.data.relationships.build.data.id, "build-4");
      externalState = "WAITING_FOR_BETA_REVIEW";
      return json(201, {
        data: { type: "betaAppReviewSubmissions", id: "review-1" },
      });
    }
    return notFound();
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    groups,
    builds,
    localizations,
  };
}

const internalTeam: Group = {
  id: "group-team",
  name: "Screenr team",
  isInternalGroup: true,
  hasAccessToAllBuilds: true,
};
const release = {
  bundleId: "com.artisanalsoftware.Screenr",
  version: "1.0",
  build: 4,
  notes: "- Add the You tab",
  submitReview: false,
};

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

async function distributeWith(
  connect: ReturnType<typeof fakeConnect>,
  overrides: Partial<typeof release> = {},
) {
  const waits: number[] = [];
  const lines: string[] = [];
  const result = await withKey(async ({ credentials }) =>
    distribute(
      await appStoreConnect(credentials, connect.fetch),
      { ...release, ...overrides },
      {
        sleep: async (milliseconds) => void waits.push(milliseconds),
        log: (line) => void lines.push(line),
        timeout: 5 * 60_000,
        interval: 30_000,
      },
    ),
  );
  return { result, waits, lines };
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
  });
});

test("distribution waits for processing, sets What to Test, and adds the build to the external group", async () => {
  const connect = fakeConnect({
    processing: [undefined, "PROCESSING", "VALID"],
    localization: "",
    groups: [internalTeam],
  });
  const { result, waits } = await distributeWith(connect);
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.deepEqual(connect.localizations, [
    { id: "loc-1", locale: "en-US", whatsNew: "- Add the You tab" },
  ]);
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
  assert.deepEqual([...connect.builds], ["group-new"]);
  assert.deepEqual(result, {
    build: "build-4",
    groups: ["Public testers", "Screenr team"],
    externalState: "READY_FOR_BETA_SUBMISSION",
  });
  // Beta App Review and the public link wait for an explicit request.
  assert.ok(
    !connect.requests.some(
      ({ path, body }) =>
        path === "/v1/betaAppReviewSubmissions" ||
        body?.data?.attributes?.publicLinkEnabled,
    ),
  );
});

test("distribution reaches an internal group without automatic access and submits review on request", async () => {
  const connect = fakeConnect({
    groups: [
      { ...internalTeam, hasAccessToAllBuilds: false },
      {
        id: "group-public",
        name: "Public testers",
        isInternalGroup: false,
        hasAccessToAllBuilds: false,
      },
    ],
  });
  const { result } = await distributeWith(connect, { submitReview: true });
  assert.deepEqual(connect.localizations, [
    { id: "loc-new", locale: "en-US", whatsNew: "- Add the You tab" },
  ]);
  assert.deepEqual([...connect.builds].sort(), ["group-public", "group-team"]);
  assert.ok(
    !connect.requests.some(
      ({ method, path }) => method === "POST" && path === "/v1/betaGroups",
    ),
  );
  assert.deepEqual(result.externalState, "WAITING_FOR_BETA_REVIEW");

  // Running again changes nothing that is already in place.
  const again = fakeConnect({
    groups: connect.groups,
    localization: "- Add the You tab",
    externalState: "WAITING_FOR_BETA_REVIEW",
  });
  for (const id of connect.builds) again.builds.add(id);
  await distributeWith(again, { submitReview: true });
  assert.deepEqual(
    again.requests
      .filter(({ method }) => method !== "GET")
      .map(({ method, path }) => `${method} ${path}`),
    ["PATCH /v1/betaBuildLocalizations/loc-1"],
  );
});

test("distribution stops when Apple rejects or never finishes the build", async () => {
  for (const state of ["FAILED", "INVALID"])
    await assert.rejects(distributeWith(fakeConnect({ processing: [state] })), {
      message: `App Store Connect marked 1.0 (4) ${state}. Check the build's email from Apple and TestFlight's Build Uploads.`,
    });
  const waiting = fakeConnect({ processing: [undefined] });
  await assert.rejects(distributeWith(waiting), {
    message:
      "1.0 (4) did not finish processing in 5 minutes. Run bin/ios-testflight --distribute-only to keep waiting.",
  });
  assert.ok(!waiting.requests.some(({ method }) => method !== "GET"));
});

test("distribution reports why App Store Connect refused the external group", async () => {
  const connect = fakeConnect({
    groups: [internalTeam],
    createGroup: () =>
      json(409, {
        errors: [
          {
            status: "409",
            title: "The request entity is not valid.",
            detail: "External groups need a build first.",
          },
        ],
      }),
  });
  await assert.rejects(distributeWith(connect), {
    message:
      'Could not create the external group "Public testers": App Store Connect POST /v1/betaGroups failed with 409: The request entity is not valid.: External groups need a build first. Create it in TestFlight in App Store Connect, then run bin/ios-testflight --distribute-only.',
  });
  // What to Test is already set, so internal testers see the notes.
  assert.equal(connect.localizations[0]?.whatsNew, "- Add the You tab");
});
