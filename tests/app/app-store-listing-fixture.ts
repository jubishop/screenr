import assert from "node:assert/strict";
import { json, refusal, type Recorded } from "./app-store-connect-fixture";

// An in-memory App Store Connect for the listing tests, with one app, app-1,
// an App Store version being prepared, and Apple's asset upload host. It
// answers only the requests scripts/app-store-listing.ts makes, records each
// one, and keeps what they change.

const api = "https://api.appstoreconnect.apple.com";
export const uploadHost = "https://uploads.example.com";

type Attributes = Record<string, unknown>;
type Row = { id: string; attributes: Attributes };

export type FakeScreenshot = {
  id: string;
  fileName: string;
  fileSize: number;
  checksum: string | null;
  state: string;
  // The bytes the upload operations sent, in order.
  received: Uint8Array[];
};

export type ListingOptions = {
  versions?: { id: string; versionString: string; appVersionState: string }[];
  infos?: { id: string; state: string }[];
  // The version's localizations, which a new version starts with.
  localizations?: Attributes[];
  availability?: {
    availableInNewTerritories: boolean;
    available: string[];
  };
  territories?: string[];
  contact?: Attributes;
  reviewDetail?: Attributes;
  // Whether App Store Connect stores URLs with a trailing slash.
  slashUrls?: boolean;
  // The state a committed screenshot reaches on each poll, last repeating.
  processing?: (fileName: string) => string[];
};

export function fakeListing(options: ListingOptions = {}) {
  const requests: Recorded[] = [];
  const uploads: { url: string; authorization: string | null }[] = [];
  let next = 0;
  const id = (prefix: string) => `${prefix}-${++next}`;
  const app: Attributes = { contentRightsDeclaration: null };
  const versions: Row[] = (
    options.versions ?? [
      {
        id: "version-1",
        versionString: "1.0",
        appVersionState: "PREPARE_FOR_SUBMISSION",
      },
    ]
  ).map(({ id, ...attributes }) => ({
    id,
    attributes: { platform: "IOS", copyright: null, ...attributes },
  }));
  const localizations: (Row & { version: string })[] = (
    options.localizations ?? [{ locale: "en-US" }]
  ).map((attributes) => ({
    id: id("localization"),
    version: versions[0]!.id,
    attributes: {
      description: null,
      keywords: null,
      promotionalText: null,
      supportUrl: null,
      marketingUrl: null,
      whatsNew: null,
      ...attributes,
    },
  }));
  const infos = (
    options.infos ?? [{ id: "info-1", state: "PREPARE_FOR_SUBMISSION" }]
  ).map(({ id, state }) => ({
    id,
    attributes: { state } as Attributes,
    categories: {
      primaryCategory: null as string | null,
      secondaryCategory: null as string | null,
    },
    localization: {
      id: `${id}-en-US`,
      attributes: {
        locale: "en-US",
        name: "Screenr",
        subtitle: null,
        privacyPolicyUrl: null,
      } as Attributes,
    },
    ageRating: {
      ageRatingOverrideV2: "NONE",
      userGeneratedContent: null,
    } as Attributes,
  }));
  const territories = options.territories ?? ["CAN", "GBR", "USA"];
  let availability:
    { availableInNewTerritories: boolean; rows: Map<string, Row> } | undefined =
    options.availability && {
      availableInNewTerritories: options.availability.availableInNewTerritories,
      rows: new Map(
        territories.map((territory) => [
          territory,
          {
            id: `availability-${territory}`,
            attributes: {
              available: options.availability!.available.includes(territory),
            },
          },
        ]),
      ),
    };
  const contact = options.contact ?? {
    contactFirstName: "Pat",
    contactLastName: "Owner",
    contactPhone: "5550100",
    contactEmail: "owner@example.com",
  };
  let reviewDetail: Row | undefined = options.reviewDetail && {
    id: "review-1",
    attributes: options.reviewDetail,
  };
  const sets: { id: string; localization: string; type: string }[] = [];
  const screenshots = new Map<string, FakeScreenshot[]>();
  const polls = new Map<string, string[]>();

  const stored = (value: unknown) =>
    options.slashUrls &&
    typeof value === "string" &&
    /^https:\/\/[^/]+$/.test(value)
      ? `${value}/`
      : value;
  const store = (row: Attributes, attributes: Attributes) => {
    for (const [key, value] of Object.entries(attributes))
      row[key] = stored(value);
  };
  const shot = (screenshot: FakeScreenshot) => ({
    type: "appScreenshots",
    id: screenshot.id,
    attributes: {
      fileName: screenshot.fileName,
      fileSize: screenshot.fileSize,
      sourceFileChecksum: screenshot.checksum,
      assetDeliveryState: { state: screenshot.state },
    },
  });
  const one = (type: string, row: Row) =>
    json(200, { data: { type, id: row.id, attributes: row.attributes } });
  const notFound = () => refusal(404, "Not found", "No such resource.");

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.origin === uploadHost) {
      uploads.push({
        url: url.href,
        authorization: headers.get("authorization"),
      });
      const match = /^\/(shot-\d+)\/(\d+)$/.exec(url.pathname)!;
      const found = [...screenshots.values()]
        .flat()
        .find((screenshot) => screenshot.id === match[1]);
      assert.ok(found);
      assert.equal(method, "PUT");
      assert.equal(headers.get("content-type"), "image/png");
      found.received[Number(match[2])] = new Uint8Array(
        init?.body as Uint8Array,
      );
      return new Response(null, { status: 200 });
    }
    assert.equal(url.origin, api);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method,
      path: url.pathname,
      search: url.searchParams,
      body,
      authorization: headers.get("authorization") ?? "",
    });
    const path = url.pathname;
    const route = `${method} ${path}`;
    let match: RegExpExecArray | null;

    if (route === "GET /v1/apps/app-1/appStoreVersions")
      return json(200, {
        data: versions.map((row) => ({ type: "appStoreVersions", ...row })),
      });
    if (
      (match = /^\/v1\/appStoreVersions\/([^/]+)$/.exec(path)) &&
      method === "PATCH"
    ) {
      const version = versions.find((row) => row.id === match![1]);
      if (!version) return notFound();
      store(version.attributes, body.data.attributes);
      return one("appStoreVersions", version);
    }
    if (
      (match =
        /^\/v1\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/.exec(
          path,
        ))
    )
      return json(200, {
        data: localizations
          .filter((row) => row.version === match![1])
          .map(({ id, attributes }) => ({
            type: "appStoreVersionLocalizations",
            id,
            attributes,
          })),
      });
    if (route === "POST /v1/appStoreVersionLocalizations") {
      const row = {
        id: id("localization"),
        version: body.data.relationships.appStoreVersion.data.id,
        attributes: {} as Attributes,
      };
      store(row.attributes, body.data.attributes);
      localizations.push(row);
      return one("appStoreVersionLocalizations", row);
    }
    if ((match = /^\/v1\/appStoreVersionLocalizations\/([^/]+)$/.exec(path))) {
      const row = localizations.find((item) => item.id === match![1]);
      if (!row) return notFound();
      store(row.attributes, body.data.attributes);
      return one("appStoreVersionLocalizations", row);
    }
    if (route === "GET /v1/apps/app-1/appInfos") {
      assert.equal(
        url.searchParams.get("include"),
        "primaryCategory,secondaryCategory",
      );
      return json(200, {
        data: infos.map((info) => ({
          type: "appInfos",
          id: info.id,
          attributes: info.attributes,
          relationships: Object.fromEntries(
            Object.entries(info.categories).map(([name, category]) => [
              name,
              {
                data: category ? { type: "appCategories", id: category } : null,
              },
            ]),
          ),
        })),
      });
    }
    const info =
      (match = /^\/v1\/appInfos\/([^/]+)(\/.*)?$/.exec(path)) &&
      infos.find((item) => item.id === match![1]);
    if (info && match![2] === undefined && method === "PATCH") {
      for (const [name, link] of Object.entries(
        body.data.relationships as Record<string, { data: { id: string } }>,
      ))
        info.categories[name as keyof typeof info.categories] = link.data.id;
      return json(200, { data: { type: "appInfos", id: info.id } });
    }
    if (info && match![2] === "/appInfoLocalizations")
      return json(200, {
        data: [{ type: "appInfoLocalizations", ...info.localization }],
      });
    if (info && match![2] === "/ageRatingDeclaration")
      return json(200, {
        data: {
          type: "ageRatingDeclarations",
          id: info.id,
          attributes: info.ageRating,
        },
      });
    if ((match = /^\/v1\/appInfoLocalizations\/([^/]+)$/.exec(path))) {
      const row = infos.find((item) => item.localization.id === match![1]);
      if (!row) return notFound();
      store(row.localization.attributes, body.data.attributes);
      return one("appInfoLocalizations", row.localization);
    }
    if ((match = /^\/v1\/ageRatingDeclarations\/([^/]+)$/.exec(path))) {
      const row = infos.find((item) => item.id === match![1]);
      if (!row) return notFound();
      store(row.ageRating, body.data.attributes);
      return one("ageRatingDeclarations", {
        id: row.id,
        attributes: row.ageRating,
      });
    }
    if (route === "GET /v1/apps/app-1")
      return one("apps", { id: "app-1", attributes: app });
    if (route === "PATCH /v1/apps/app-1") {
      store(app, body.data.attributes);
      return one("apps", { id: "app-1", attributes: app });
    }
    if (route === "GET /v1/apps/app-1/appAvailabilityV2")
      return availability
        ? json(200, {
            data: {
              type: "appAvailabilities",
              id: "app-1",
              attributes: {
                availableInNewTerritories:
                  availability.availableInNewTerritories,
              },
            },
          })
        : refusal(
            404,
            "The specified resource does not exist",
            "There is no resource of type 'appAvailabilities' with id 'app-1'",
          );
    if (route === "GET /v1/territories")
      return json(200, {
        data: territories.map((territory) => ({
          type: "territories",
          id: territory,
        })),
      });
    if (route === "POST /v2/appAvailabilities") {
      if (availability) return refusal(409, "Conflict", "Availability exists.");
      const { data, included } = body;
      assert.equal(data.relationships.app.data.id, "app-1");
      assert.deepEqual(
        data.relationships.territoryAvailabilities.data.map(
          ({ id }: { id: string }) => id,
        ),
        included.map(({ id }: { id: string }) => id),
      );
      availability = {
        availableInNewTerritories: data.attributes.availableInNewTerritories,
        rows: new Map(
          included.map(
            (item: {
              id: string;
              attributes: { available: boolean };
              relationships: { territory: { data: { id: string } } };
            }) => {
              assert.equal(
                item.id,
                `\${${item.relationships.territory.data.id}}`,
              );
              const territory = item.relationships.territory.data.id;
              return [
                territory,
                {
                  id: `availability-${territory}`,
                  attributes: { available: item.attributes.available },
                },
              ];
            },
          ),
        ),
      };
      return json(201, { data: { type: "appAvailabilities", id: "app-1" } });
    }
    if (route === "GET /v2/appAvailabilities/app-1/territoryAvailabilities") {
      assert.equal(url.searchParams.get("include"), "territory");
      return json(200, {
        data: [...(availability?.rows ?? [])].map(([territory, row]) => ({
          type: "territoryAvailabilities",
          id: row.id,
          attributes: row.attributes,
          relationships: {
            territory: { data: { type: "territories", id: territory } },
          },
        })),
      });
    }
    if ((match = /^\/v1\/territoryAvailabilities\/([^/]+)$/.exec(path))) {
      const row = [...(availability?.rows.values() ?? [])].find(
        (item) => item.id === match![1],
      );
      if (!row) return notFound();
      row.attributes.available = body.data.attributes.available;
      return json(200, { data: { type: "territoryAvailabilities", ...row } });
    }
    if (route === "GET /v1/apps/app-1/betaAppReviewDetail")
      return json(200, {
        data: {
          type: "betaAppReviewDetails",
          id: "app-1",
          attributes: contact,
        },
      });
    if (
      (match = /^\/v1\/appStoreVersions\/([^/]+)\/appStoreReviewDetail$/.exec(
        path,
      ))
    )
      return json(200, {
        data: reviewDetail
          ? { type: "appStoreReviewDetails", ...reviewDetail }
          : null,
      });
    if (route === "POST /v1/appStoreReviewDetails") {
      assert.equal(
        body.data.relationships.appStoreVersion.data.id,
        "version-1",
      );
      reviewDetail = {
        id: "review-1",
        attributes: { ...body.data.attributes },
      };
      return one("appStoreReviewDetails", reviewDetail);
    }
    if (route === "PATCH /v1/appStoreReviewDetails/review-1") {
      store(reviewDetail!.attributes, body.data.attributes);
      return one("appStoreReviewDetails", reviewDetail!);
    }
    if (
      (match =
        /^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/.exec(
          path,
        ))
    )
      return json(200, {
        data: sets
          .filter((set) => set.localization === match![1])
          .map((set) => ({
            type: "appScreenshotSets",
            id: set.id,
            attributes: { screenshotDisplayType: set.type },
          })),
      });
    if (route === "POST /v1/appScreenshotSets") {
      const set = {
        id: id("set"),
        localization:
          body.data.relationships.appStoreVersionLocalization.data.id,
        type: body.data.attributes.screenshotDisplayType,
      };
      assert.ok(localizations.some((row) => row.id === set.localization));
      sets.push(set);
      screenshots.set(set.id, []);
      return json(201, { data: { type: "appScreenshotSets", id: set.id } });
    }
    if (
      (match = /^\/v1\/appScreenshotSets\/([^/]+)\/appScreenshots$/.exec(path))
    )
      return json(200, {
        data: (screenshots.get(match[1]!) ?? []).map(shot),
      });
    if (
      (match =
        /^\/v1\/appScreenshotSets\/([^/]+)\/relationships\/appScreenshots$/.exec(
          path,
        ))
    ) {
      const list = screenshots.get(match[1]!)!;
      const order = body.data.map(({ id }: { id: string }) => id);
      assert.deepEqual([...order].sort(), list.map(({ id }) => id).sort());
      list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      return json(204);
    }
    if (route === "POST /v1/appScreenshots") {
      const set = body.data.relationships.appScreenshotSet.data.id;
      const { fileName, fileSize } = body.data.attributes;
      const created: FakeScreenshot = {
        id: id("shot"),
        fileName,
        fileSize,
        checksum: null,
        state: "AWAITING_UPLOAD",
        received: [],
      };
      screenshots.get(set)!.push(created);
      // Two parts, as Apple splits larger files.
      const half = Math.ceil(fileSize / 2);
      const operation = (part: number, offset: number, length: number) => ({
        method: "PUT",
        url: `${uploadHost}/${created.id}/${part}`,
        offset,
        length,
        requestHeaders: [{ name: "Content-Type", value: "image/png" }],
      });
      return json(201, {
        data: {
          ...shot(created),
          attributes: {
            ...shot(created).attributes,
            uploadOperations: [
              operation(0, 0, half),
              operation(1, half, fileSize - half),
            ],
          },
        },
      });
    }
    if ((match = /^\/v1\/appScreenshots\/([^/]+)$/.exec(path))) {
      const found = [...screenshots.entries()].find(([, list]) =>
        list.some((item) => item.id === match![1]),
      );
      if (!found) return notFound();
      const [set, list] = found;
      const screenshot = list.find((item) => item.id === match![1])!;
      if (method === "DELETE") {
        screenshots.set(
          set,
          list.filter((item) => item !== screenshot),
        );
        return json(204);
      }
      if (method === "PATCH") {
        assert.equal(body.data.attributes.uploaded, true);
        screenshot.checksum = body.data.attributes.sourceFileChecksum;
        screenshot.state = "UPLOAD_COMPLETE";
        polls.set(
          screenshot.id,
          options.processing?.(screenshot.fileName) ?? ["COMPLETE"],
        );
        return one("appScreenshots", shot(screenshot));
      }
      const states = polls.get(screenshot.id);
      if (states?.length) {
        screenshot.state = states.length > 1 ? states.shift()! : states[0]!;
      }
      return json(200, { data: shot(screenshot) });
    }
    return notFound();
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    uploads,
    app,
    versions,
    localizations,
    infos,
    contact,
    sets,
    screenshots,
    availability: () => availability,
    reviewDetail: () => reviewDetail,
    // The requests that change something, as "METHOD /path".
    writes: () =>
      requests
        .filter(({ method }) => method !== "GET")
        .map(({ method, path }) => `${method} ${path}`),
    // The territories the app is available in.
    available: () =>
      [...(availability?.rows ?? [])]
        .filter(([, row]) => row.attributes.available)
        .map(([territory]) => territory),
  };
}
