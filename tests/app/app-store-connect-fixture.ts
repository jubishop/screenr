import assert from "node:assert/strict";

// An in-memory App Store Connect with one app, app-1, for the release tests.
// It answers only the requests scripts/app-store-connect.ts makes, records
// every request, and keeps the builds, groups, notes, and testers they
// change.

export type Recorded = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
  authorization: string;
};

export type FakeBuild = {
  id: string;
  version: string;
  build: number;
  // Each lookup of the build by number reads the first state and drops it
  // while more remain. undefined means the build has not appeared yet, and
  // other lists leave it out until it has.
  processing: (string | undefined)[];
  externalState: string;
  expired: boolean;
  usesNonExemptEncryption: boolean | null;
};

export type FakeGroup = {
  id: string;
  name: string;
  isInternalGroup: boolean;
  hasAccessToAllBuilds: boolean;
};

export const internalTeam: FakeGroup = {
  id: "group-team",
  name: "Screenr team",
  isInternalGroup: true,
  hasAccessToAllBuilds: true,
};
export const publicTesters: FakeGroup = {
  id: "group-public",
  name: "Public testers",
  isInternalGroup: false,
  hasAccessToAllBuilds: false,
};

// A TestFlight tester of the team, in the groups it lists by ID. Testers who
// joined through a public link may have no email.
export type FakeTester = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  inviteType: string;
  state: string;
  groups: Set<string>;
};

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
export const refusal = (status: number, title: string, detail: string) =>
  json(status, { errors: [{ status: String(status), title, detail }] });
const notFound = () => refusal(404, "Not found", "No such route.");

export type FakeOptions = {
  builds?: (Partial<FakeBuild> & { version: string; build: number })[];
  groups?: FakeGroup[];
  // The builds each group holds, by group ID.
  members?: Record<string, number[]>;
  localizations?: { build: number; whatsNew: string }[];
  testers?: (Partial<Omit<FakeTester, "groups">> & { groups?: string[] })[];
  // The state a tester takes on joining a group. Apple invites a tester it
  // adds to an external group with a build in testing.
  joinedState?: string;
  // Removed testers stay in the group's list as REVOKED.
  revokeOnRemoval?: boolean;
  pageSize?: number;
  // Each hook may answer instead of the fake, such as with a refusal.
  createGroup?: () => Response | undefined;
  expire?: (build: FakeBuild) => Response | undefined;
  submit?: (build: FakeBuild) => Response | undefined;
  createTester?: () => Response | undefined;
  removeTester?: () => Response | undefined;
};

export function fakeConnect(options: FakeOptions = {}) {
  const requests: Recorded[] = [];
  const builds: FakeBuild[] = [];
  const upload = (
    version: string,
    build: number,
    overrides: Partial<FakeBuild> = {},
  ) => {
    const created: FakeBuild = {
      id: `build-${build}`,
      version,
      build,
      processing: ["VALID"],
      externalState: "READY_FOR_BETA_SUBMISSION",
      expired: false,
      usesNonExemptEncryption: false,
      ...overrides,
    };
    builds.push(created);
    return created;
  };
  for (const { version, build, ...rest } of options.builds ?? [])
    upload(version, build, rest);
  const groups = [...(options.groups ?? [])];
  const members = new Map(
    Object.entries(options.members ?? {}).map(([group, numbers]) => [
      group,
      new Set(numbers.map((build) => `build-${build}`)),
    ]),
  );
  const localizations = (options.localizations ?? []).map(
    ({ build, whatsNew }, index) => ({
      id: `loc-${index + 1}`,
      build: `build-${build}`,
      locale: "en-US",
      whatsNew,
    }),
  );
  const testers: FakeTester[] = (options.testers ?? []).map(
    ({ groups = [], ...tester }, index) => ({
      id: `tester-${index + 1}`,
      inviteType: tester.email ? "EMAIL" : "PUBLIC_LINK",
      state: "INSTALLED",
      ...tester,
      groups: new Set(groups),
    }),
  );
  const joined = (tester: FakeTester, group: string) => {
    tester.groups.add(group);
    tester.state = options.joinedState ?? "INVITED";
  };
  const testerResource = ({ id, groups, ...attributes }: FakeTester) => ({
    type: "betaTesters",
    id,
    attributes,
  });
  const invitations: { app: string; tester: string }[] = [];
  const byId = (id: string) => builds.find((build) => build.id === id);
  const detail = (build: FakeBuild) => ({
    type: "buildBetaDetails",
    id: `detail-${build.build}`,
    attributes: { externalBuildState: build.externalState },
  });
  const resource = (build: FakeBuild, state = build.processing[0]) => ({
    type: "builds",
    id: build.id,
    attributes: {
      version: String(build.build),
      expired: build.expired,
      processingState: state,
      usesNonExemptEncryption: build.usesNonExemptEncryption,
    },
    relationships: {
      buildBetaDetail: {
        data: { type: "buildBetaDetails", id: `detail-${build.build}` },
      },
    },
  });

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
    const one = url.pathname.match(/^\/v1\/builds\/(build-\d+)$/);
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
      const platform = filter("preReleaseVersion.platform");
      if (platform) assert.equal(platform, "IOS");
      if (!filter("betaGroups")) assert.equal(filter("app"), "app-1");
      const number = filter("version");
      // A lookup by number polls the build's processing. Once the build is
      // valid, TestFlight finishes its own processing by the next poll.
      if (number) {
        const found = builds.find(
          (build) =>
            String(build.build) === number &&
            build.version === filter("preReleaseVersion.version"),
        );
        const state = found?.processing[0];
        if (found && found.processing.length > 1) found.processing.shift();
        const listed = found && state !== undefined ? [found] : [];
        const response = json(200, {
          data: listed.map((build) => resource(build, state)),
          included:
            url.searchParams.get("include") === "buildBetaDetail"
              ? listed.map(detail)
              : undefined,
        });
        if (state === "VALID" && found?.externalState === "PROCESSING")
          found.externalState = "READY_FOR_BETA_SUBMISSION";
        return response;
      }
      let found = builds.filter(
        ({ processing }) => processing[0] !== undefined,
      );
      const group = filter("betaGroups");
      if (group) found = found.filter(({ id }) => members.get(group)?.has(id));
      const version = filter("preReleaseVersion.version");
      if (version) found = found.filter((build) => build.version === version);
      const expired = filter("expired");
      if (expired)
        found = found.filter((build) => String(build.expired) === expired);
      if (url.searchParams.get("sort") === "-uploadedDate")
        found.sort((a, b) => b.build - a.build);
      const size = Math.min(
        Number(url.searchParams.get("limit") ?? 50),
        options.pageSize ?? Infinity,
      );
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const page = found.slice(offset, offset + size);
      const next = new URL(url);
      next.searchParams.set("cursor", String(offset + size));
      return json(200, {
        data: page.map((build) => resource(build)),
        included:
          url.searchParams.get("include") === "buildBetaDetail"
            ? page.map(detail)
            : undefined,
        links: offset + size < found.length ? { next: next.href } : {},
      });
    }
    if (method === "GET" && one) {
      const build = byId(one[1]!);
      if (!build) return notFound();
      return json(200, { data: resource(build), included: [detail(build)] });
    }
    if (method === "PATCH" && one) {
      const build = byId(one[1]!);
      if (!build) return notFound();
      const refused = options.expire?.(build);
      if (refused) return refused;
      assert.deepEqual(body, {
        data: { type: "builds", id: build.id, attributes: { expired: true } },
      });
      build.expired = true;
      build.externalState = "EXPIRED";
      return json(200, { data: resource(build) });
    }
    const beta = url.pathname.match(
      /^\/v1\/builds\/(build-\d+)\/buildBetaDetail$/,
    );
    if (method === "GET" && beta) {
      const build = byId(beta[1]!);
      return build ? json(200, { data: detail(build) }) : notFound();
    }
    const notes = url.pathname.match(
      /^\/v1\/builds\/(build-\d+)\/betaBuildLocalizations$/,
    );
    if (method === "GET" && notes)
      return json(200, {
        data: localizations
          .filter(({ build }) => build === notes[1])
          .map(({ id, locale, whatsNew }) => ({
            type: "betaBuildLocalizations",
            id,
            attributes: { locale, whatsNew },
          })),
      });
    if (route === "POST /v1/betaBuildLocalizations") {
      const build = body.data.relationships.build.data.id;
      assert.ok(byId(build));
      const created = {
        id: `loc-${localizations.length + 1}`,
        build,
        locale: body.data.attributes.locale,
        whatsNew: body.data.attributes.whatsNew,
      };
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
    if (route === "GET /v1/betaGroups" && filter("builds"))
      return json(200, {
        data: groups
          .filter(({ id }) => members.get(id)?.has(filter("builds")!))
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
      assert.equal(body.data.length, 1);
      assert.ok(byId(body.data[0].id));
      if (!members.has(added[1]!)) members.set(added[1]!, new Set());
      members.get(added[1]!)!.add(body.data[0].id);
      return json(204);
    }
    if (route === "POST /v1/betaAppReviewSubmissions") {
      const build = byId(body.data.relationships.build.data.id);
      if (!build) return notFound();
      const refused = options.submit?.(build);
      if (refused) return refused;
      build.externalState = "WAITING_FOR_BETA_REVIEW";
      return json(201, {
        data: { type: "betaAppReviewSubmissions", id: `review-${build.build}` },
      });
    }
    const listing = url.pathname.match(
      /^\/v1\/betaGroups\/([^/]+)\/betaTesters$/,
    );
    if (method === "GET" && listing) {
      const found = testers.filter(({ groups }) => groups.has(listing[1]!));
      const size = Math.min(
        Number(url.searchParams.get("limit") ?? 50),
        options.pageSize ?? Infinity,
      );
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const next = new URL(url);
      next.searchParams.set("cursor", String(offset + size));
      return json(200, {
        data: found.slice(offset, offset + size).map(testerResource),
        links: offset + size < found.length ? { next: next.href } : {},
      });
    }
    if (route === "GET /v1/betaTesters") {
      // The release tooling looks testers up by email, never the whole team.
      const email = filter("email");
      assert.ok(email);
      const group = filter("betaGroups");
      return json(200, {
        data: testers
          .filter(
            (tester) =>
              tester.email?.toLowerCase() === email.toLowerCase() &&
              (!group || tester.groups.has(group)),
          )
          .map(testerResource),
      });
    }
    if (route === "POST /v1/betaTesters") {
      const refused = options.createTester?.();
      if (refused) return refused;
      const { email } = body.data.attributes;
      if (testers.some((tester) => tester.email === email))
        return refusal(
          409,
          "The provided entity includes an attribute with a value that has already been used.",
          "A tester with this email already exists.",
        );
      const groups = body.data.relationships.betaGroups.data.map(
        ({ type, id }: { type: string; id: string }) => {
          assert.equal(type, "betaGroups");
          return id;
        },
      );
      const tester: FakeTester = {
        id: `tester-${testers.length + 1}`,
        email,
        inviteType: "EMAIL",
        state: "NOT_INVITED",
        groups: new Set(),
      };
      testers.push(tester);
      for (const group of groups) joined(tester, group);
      return json(201, { data: testerResource(tester) });
    }
    const membership = url.pathname.match(
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters$/,
    );
    if (membership && (method === "POST" || method === "DELETE")) {
      const refused =
        method === "DELETE" ? options.removeTester?.() : undefined;
      if (refused) return refused;
      for (const { type, id } of body.data) {
        assert.equal(type, "betaTesters");
        const tester = testers.find((found) => found.id === id);
        if (!tester) return notFound();
        if (method === "POST") joined(tester, membership[1]!);
        else if (options.revokeOnRemoval) tester.state = "REVOKED";
        else tester.groups.delete(membership[1]!);
      }
      return json(204);
    }
    if (route === "POST /v1/betaTesterInvitations") {
      const app = body.data.relationships.app.data;
      const invited = body.data.relationships.betaTester.data;
      assert.deepEqual([app.type, invited.type], ["apps", "betaTesters"]);
      const tester = testers.find(({ id }) => id === invited.id);
      if (app.id !== "app-1" || !tester) return notFound();
      tester.state = "INVITED";
      invitations.push({ app: app.id, tester: tester.id });
      return json(201, {
        data: { type: "betaTesterInvitations", id: `invitation-${tester.id}` },
      });
    }
    return notFound();
  };

  // The requests that change something, as "METHOD /path".
  const writes = () =>
    requests
      .filter(({ method }) => method !== "GET")
      .map(({ method, path }) => `${method} ${path}`);
  const holding = (group: string) => [...(members.get(group) ?? [])].sort();
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    builds,
    groups,
    members,
    localizations,
    testers,
    invitations,
    upload,
    writes,
    holding,
    // The emails of a group's testers, with each one's state.
    inGroup: (group: string) =>
      testers
        .filter(({ groups }) => groups.has(group))
        .map(({ email, state }) => `${email ?? "no email"} ${state}`)
        .sort(),
    build: (number: number) => builds.find(({ build }) => build === number),
  };
}
