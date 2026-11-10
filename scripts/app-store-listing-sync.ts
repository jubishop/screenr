import {
  AppStoreConnectError,
  every,
  query,
  type App,
  type AppStoreConnect,
  type One,
  type Resource,
  type UploadOperation,
} from "./app-store-connect";
import type { Listing, Screenshot } from "./app-store-listing";

// The App Store Connect side of the App Store listing upload
// (docs/running-screenr.md#app-store-listing): it brings an App Store
// version's listing in line with the repository's, part by part, changing a
// part only when it differs, so a rerun changes nothing. bin/app-store-listing
// runs it, and bin/appstore reuses it.

// The description's paragraphs, with a blank line between them, and the
// keywords, as App Store Connect stores them.
export const descriptionText = (listing: Listing) =>
  listing.description.join("\n\n");
export const keywordsText = (listing: Listing) => listing.keywords.join(",");

export type Sync = {
  // Without it, the sync only reports what it would change.
  apply: boolean;
  log: (line: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  // How long to wait for App Store Connect to process a screenshot.
  timeout: number;
  interval?: number;
};

type Attributes = Record<string, unknown>;

// App Store Connect returns URLs as entered or with a trailing slash.
const comparable = (value: unknown) => {
  if (typeof value === "string" && /^https:\/\//.test(value))
    try {
      return new URL(value).href;
    } catch {
      return value;
    }
  return value ?? null;
};
const differing = (current: Attributes, wanted: Attributes) =>
  Object.keys(wanted).filter(
    (key) => comparable(current[key]) !== comparable(wanted[key]),
  );
const pick = (attributes: Attributes, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, attributes[key]]));

// The versions App Store Connect lets a developer edit.
const editableVersions = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
];
const editableInfos = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
];

type Version = {
  versionString: string;
  appVersionState: string;
  copyright: string | null;
  platform: string;
};

// The iOS version the listing goes to: the one named, or the only one App
// Store Connect lets a developer edit.
async function editableVersion(
  api: AppStoreConnect,
  app: string,
  versionString?: string,
) {
  const versions = (
    await every<Version>(
      api,
      query(`/v1/apps/${app}/appStoreVersions`, {
        "filter[platform]": "IOS",
        "fields[appStoreVersions]":
          "platform,versionString,appVersionState,copyright",
        limit: "200",
      }),
    )
  ).filter(
    ({ attributes }) =>
      attributes.platform === "IOS" &&
      editableVersions.includes(attributes.appVersionState),
  );
  const names = versions.map(({ attributes }) => attributes.versionString);
  const found = versionString
    ? versions.find(
        ({ attributes }) => attributes.versionString === versionString,
      )
    : versions.length === 1
      ? versions[0]
      : undefined;
  if (found) return found;
  if (!versions.length)
    throw new Error(
      "App Store Connect has no App Store version of Screenr to edit. Create the next version, which bin/appstore does, then run this again.",
    );
  throw new Error(
    versionString
      ? `App Store Connect has no editable App Store version ${versionString}; it has ${names.join(", ")}.`
      : `App Store Connect has several editable App Store versions, ${names.join(", ")}; name one with --version.`,
  );
}

// Records a change and reports it, as "Setting …" or, in a dry run, "Would
// set …".
function announce(sync: Sync, changes: string[], change: string) {
  changes.push(change);
  const planned = change
    .replace(/^Setting /, "Would set ")
    .replace(/^Creating /, "Would create ");
  sync.log(`==> ${sync.apply ? change : planned}`);
}

// Brings one resource's attributes to the wanted values, creating it when it
// is missing, and confirms what App Store Connect stored.
async function settle(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  what: string,
  {
    type,
    current,
    wanted,
    create,
    hidden = false,
  }: {
    type: string;
    current: Resource<Attributes> | undefined;
    wanted: Attributes;
    create?: { path: string; relationships: Record<string, unknown> };
    // Names only the fields, never their values, such as the sign-in code.
    hidden?: boolean;
  },
) {
  const fields = current
    ? differing(current.attributes, wanted)
    : Object.keys(wanted);
  if (!fields.length) return;
  announce(
    sync,
    changes,
    `${current ? "Setting" : "Creating"} ${what}: ${fields.join(", ")}`,
  );
  if (!sync.apply) return;
  const stored = current
    ? await api.patch<One<Attributes>>(`/v1/${type}/${current.id}`, {
        data: { type, id: current.id, attributes: pick(wanted, fields) },
      })
    : await api.post<One<Attributes>>(create!.path, {
        data: {
          type,
          attributes: wanted,
          relationships: create!.relationships,
        },
      });
  const unsaved = differing(stored.data.attributes, pick(wanted, fields));
  if (unsaved.length)
    throw new Error(
      `App Store Connect did not store ${what}'s ${unsaved.join(", ")}${hidden ? "" : ` as ${JSON.stringify(pick(wanted, unsaved))}`}.`,
    );
}

const link = (type: string, id: string) => ({ data: { type, id } });

// Brings the listing in App Store Connect in line with the repository's, and
// returns the changes, which are none when it already matches. Without the
// review details, the review information is left as it is. Every step can run
// again safely, so a rerun after a failure resumes.
export async function syncListing(
  api: AppStoreConnect,
  app: App,
  {
    listing,
    screenshots,
    review,
    version: versionString,
  }: {
    listing: Listing;
    screenshots: Record<string, Screenshot[]>;
    // The reviewer's sign-in code and the finished review notes.
    review?: { signInCode: string; notes: string };
    version?: string;
  },
  sync: Sync,
) {
  const changes: string[] = [];
  const version = await editableVersion(api, app.id, versionString);
  const label = `version ${version.attributes.versionString}`;
  sync.log(`==> Comparing the listing of ${label} with the repository's`);
  await settle(api, sync, changes, `${label}'s copyright`, {
    type: "appStoreVersions",
    current: version as Resource<Attributes>,
    wanted: { copyright: listing.copyright },
  });

  const findLocalization = async () =>
    (
      await every<Attributes>(
        api,
        query(
          `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
          { limit: "200" },
        ),
      )
    ).find(({ attributes }) => attributes.locale === listing.locale);
  const localization = await findLocalization();
  await settle(api, sync, changes, `${label}'s ${listing.locale} text`, {
    type: "appStoreVersionLocalizations",
    current: localization,
    wanted: {
      ...(!localization && { locale: listing.locale }),
      description: descriptionText(listing),
      keywords: keywordsText(listing),
      promotionalText: listing.promotionalText,
      supportUrl: listing.supportUrl,
      marketingUrl: listing.marketingUrl,
    },
    create: {
      path: "/v1/appStoreVersionLocalizations",
      relationships: { appStoreVersion: link("appStoreVersions", version.id) },
    },
  });

  await syncAppInfo(api, sync, changes, app, listing);
  await syncContentRights(api, sync, changes, app, listing);
  await syncAvailability(api, sync, changes, app, listing);
  if (review)
    await syncReview(api, sync, changes, app, version.id, label, {
      demoAccountName: listing.review.demoAccountName,
      demoAccountPassword: review.signInCode,
      demoAccountRequired: true,
      notes: review.notes,
    });
  else sync.log("==> Leaving the review information as it is");

  // A dry run that would make the localization reports every screenshot as
  // an upload.
  const target =
    localization?.id ??
    (sync.apply ? (await findLocalization())?.id : undefined);
  for (const [type, files] of Object.entries(screenshots))
    await syncScreenshots(api, sync, changes, target, type, files);
  return changes;
}

async function syncAppInfo(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  app: App,
  listing: Listing,
) {
  const infos = await every<{ state: string }>(
    api,
    query(`/v1/apps/${app.id}/appInfos`, {
      include: "primaryCategory,secondaryCategory",
      limit: "50",
    }),
  );
  const info = infos.find(({ attributes }) =>
    editableInfos.includes(attributes.state),
  );
  if (!info)
    throw new Error(
      `App Store Connect has no app information to edit; its states are ${infos.map(({ attributes }) => attributes.state).join(", ")}.`,
    );
  const category = (name: string) =>
    info.relationships?.[name]?.data?.id ?? null;
  const categories = {
    primaryCategory: listing.primaryCategory,
    secondaryCategory: listing.secondaryCategory,
  };
  const moved = Object.entries(categories).filter(
    ([name, id]) => category(name) !== id,
  );
  if (moved.length) {
    announce(
      sync,
      changes,
      `Setting the categories: ${moved.map(([name]) => name).join(", ")}`,
    );
    if (sync.apply) {
      await api.patch(`/v1/appInfos/${info.id}`, {
        data: {
          type: "appInfos",
          id: info.id,
          relationships: Object.fromEntries(
            moved.map(([name, id]) => [name, link("appCategories", id)]),
          ),
        },
      });
      const [stored] = (
        await every<{ state: string }>(
          api,
          query(`/v1/apps/${app.id}/appInfos`, {
            include: "primaryCategory,secondaryCategory",
            limit: "50",
          }),
        )
      ).filter(({ id }) => id === info.id);
      const kept = moved.filter(
        ([name, id]) => stored?.relationships?.[name]?.data?.id !== id,
      );
      if (kept.length)
        throw new Error(
          `App Store Connect did not store the ${kept.map(([name]) => name).join(", ")}.`,
        );
    }
  }

  const localizations = await every<Attributes>(
    api,
    query(`/v1/appInfos/${info.id}/appInfoLocalizations`, { limit: "200" }),
  );
  const localization = localizations.find(
    ({ attributes }) => attributes.locale === listing.locale,
  );
  await settle(
    api,
    sync,
    changes,
    `the app's ${listing.locale} name and policy`,
    {
      type: "appInfoLocalizations",
      current: localization,
      wanted: {
        ...(!localization && { locale: listing.locale }),
        name: listing.name,
        subtitle: listing.subtitle,
        privacyPolicyUrl: listing.privacyPolicyUrl,
      },
      create: {
        path: "/v1/appInfoLocalizations",
        relationships: { appInfo: link("appInfos", info.id) },
      },
    },
  );

  const declaration = (
    await api.get<One<Attributes>>(
      `/v1/appInfos/${info.id}/ageRatingDeclaration`,
    )
  ).data;
  await settle(api, sync, changes, "the age rating", {
    type: "ageRatingDeclarations",
    current: declaration,
    wanted: listing.ageRating,
  });
}

async function syncContentRights(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  app: App,
  listing: Listing,
) {
  const current = (
    await api.get<One<Attributes>>(
      query(`/v1/apps/${app.id}`, {
        "fields[apps]": "contentRightsDeclaration",
      }),
    )
  ).data;
  await settle(api, sync, changes, "the content rights declaration", {
    type: "apps",
    current,
    wanted: { contentRightsDeclaration: listing.contentRightsDeclaration },
  });
}

// The territories the app is offered in. App Store Connect has no way to
// change availableInNewTerritories once availability exists, so a mismatch
// there stops for the website.
async function syncAvailability(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  app: App,
  listing: Listing,
) {
  const { territories, availableInNewTerritories } = listing.availability;
  const wanted = new Set(territories);
  let availability:
    Resource<{ availableInNewTerritories: boolean }> | undefined;
  try {
    availability = (
      await api.get<One<{ availableInNewTerritories: boolean }>>(
        `/v1/apps/${app.id}/appAvailabilityV2`,
      )
    ).data;
  } catch (error) {
    if (!(error instanceof AppStoreConnectError && error.status === 404))
      throw error;
  }
  const only = `only ${territories.join(", ")}`;
  if (!availability) {
    const known = (
      await every<Attributes>(api, query("/v1/territories", { limit: "200" }))
    ).map(({ id }) => id);
    const unknown = territories.filter(
      (territory) => !known.includes(territory),
    );
    if (unknown.length)
      throw new Error(
        `App Store Connect has no territory ${unknown.join(", ")}.`,
      );
    announce(sync, changes, `Creating the availability: ${only}`);
    if (!sync.apply) return;
    // Each territory is listed, so every one but those wanted is off.
    const local = (territory: string) => `\${${territory}}`;
    await api.post("/v2/appAvailabilities", {
      data: {
        type: "appAvailabilities",
        attributes: { availableInNewTerritories },
        relationships: {
          app: link("apps", app.id),
          territoryAvailabilities: {
            data: known.map((territory) => ({
              type: "territoryAvailabilities",
              id: local(territory),
            })),
          },
        },
      },
      included: known.map((territory) => ({
        type: "territoryAvailabilities",
        id: local(territory),
        attributes: { available: wanted.has(territory) },
        relationships: { territory: link("territories", territory) },
      })),
    });
    availability = (
      await api.get<One<{ availableInNewTerritories: boolean }>>(
        `/v1/apps/${app.id}/appAvailabilityV2`,
      )
    ).data;
  } else if (
    availability.attributes.availableInNewTerritories !==
    availableInNewTerritories
  )
    throw new Error(
      `App Store Connect has the app ${availability.attributes.availableInNewTerritories ? "join" : "skip"} new territories, which its API cannot change. Change it in Pricing and Availability in App Store Connect, then run this again.`,
    );
  const read = () =>
    every<{ available: boolean }>(
      api,
      query(
        `/v2/appAvailabilities/${availability!.id}/territoryAvailabilities`,
        {
          include: "territory",
          "fields[territoryAvailabilities]": "available,territory",
          limit: "200",
        },
      ),
    );
  const territory = (found: Resource<{ available: boolean }>) =>
    found.relationships?.territory?.data?.id ?? "";
  const off = (found: Resource<{ available: boolean }>[]) =>
    found.filter(
      (item) => item.attributes.available !== wanted.has(territory(item)),
    );
  const listed = await read();
  const missing = territories.filter(
    (wanted) => !listed.some((item) => territory(item) === wanted),
  );
  if (missing.length)
    throw new Error(
      `App Store Connect's availability lists no ${missing.join(", ")}. Add it in Pricing and Availability in App Store Connect, then run this again.`,
    );
  const wrong = off(listed);
  if (!wrong.length) return;
  // A new availability that came out otherwise is fixed under its own change.
  if (!changes.at(-1)?.startsWith("Creating the availability"))
    announce(
      sync,
      changes,
      `Setting the availability: ${only}, changing ${wrong.length} territories`,
    );
  if (!sync.apply) return;
  for (const item of wrong)
    await api.patch(`/v1/territoryAvailabilities/${item.id}`, {
      data: {
        type: "territoryAvailabilities",
        id: item.id,
        attributes: { available: wanted.has(territory(item)) },
      },
    });
  const left = off(await read());
  if (left.length)
    throw new Error(
      `App Store Connect did not store the availability of ${left.map(territory).join(", ")}.`,
    );
}

// The review information: the contact from TestFlight's Test Information,
// the demo account, and the notes. Changes name the fields, never the code.
async function syncReview(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  app: App,
  version: string,
  label: string,
  wanted: Attributes,
) {
  const contactFields = [
    "contactFirstName",
    "contactLastName",
    "contactPhone",
    "contactEmail",
  ];
  const beta = (
    await api.get<One<Attributes>>(
      query(`/v1/apps/${app.id}/betaAppReviewDetail`, {
        "fields[betaAppReviewDetails]": contactFields.join(","),
      }),
    )
  ).data.attributes;
  const unset = contactFields.filter((field) => !beta[field]);
  if (unset.length)
    throw new Error(
      `TestFlight's Test Information has no ${unset.join(", ")}, which the review information copies. Fill them in in App Store Connect, then run this again.`,
    );
  const current =
    (
      await api.get<{ data: Resource<Attributes> | null }>(
        `/v1/appStoreVersions/${version}/appStoreReviewDetail`,
      )
    ).data ?? undefined;
  await settle(api, sync, changes, `${label}'s review information`, {
    type: "appStoreReviewDetails",
    current,
    wanted: { ...pick(beta, contactFields), ...wanted },
    create: {
      path: "/v1/appStoreReviewDetails",
      relationships: { appStoreVersion: link("appStoreVersions", version) },
    },
    hidden: true,
  });
}

type ScreenshotAttributes = {
  fileName: string;
  sourceFileChecksum: string | null;
  assetDeliveryState: {
    state: string;
    errors?: { code?: string; description?: string }[];
  } | null;
};

const screenshotFields = {
  "fields[appScreenshots]": "fileName,sourceFileChecksum,assetDeliveryState",
  limit: "50",
};

// A display type's screenshots, in order. Each finished screenshot whose file
// the listing has stays; the rest are deleted, the missing files uploaded,
// and the set put in the listing's order.
async function syncScreenshots(
  api: AppStoreConnect,
  sync: Sync,
  changes: string[],
  localization: string | undefined,
  type: string,
  files: Screenshot[],
) {
  const sets = localization
    ? await every<{ screenshotDisplayType: string }>(
        api,
        query(
          `/v1/appStoreVersionLocalizations/${localization}/appScreenshotSets`,
          {
            "fields[appScreenshotSets]": "screenshotDisplayType",
            limit: "50",
          },
        ),
      )
    : [];
  let set = sets.find(
    ({ attributes }) => attributes.screenshotDisplayType === type,
  )?.id;
  const current = set
    ? await every<ScreenshotAttributes>(
        api,
        query(`/v1/appScreenshotSets/${set}/appScreenshots`, screenshotFields),
      )
    : [];
  const done = (shot: Resource<ScreenshotAttributes>) =>
    shot.attributes.assetDeliveryState?.state === "COMPLETE";
  const kept = new Map<string, Resource<ScreenshotAttributes>>();
  for (const shot of current) {
    const checksum = shot.attributes.sourceFileChecksum ?? "";
    if (
      done(shot) &&
      files.some((file) => file.checksum === checksum) &&
      !kept.has(checksum)
    )
      kept.set(checksum, shot);
  }
  const removed = current.filter(
    (shot) => kept.get(shot.attributes.sourceFileChecksum ?? "") !== shot,
  );
  const added = files.filter((file) => !kept.has(file.checksum));
  const inOrder =
    current.length === files.length &&
    files.every((file, index) => kept.get(file.checksum) === current[index]);
  if (inOrder) return;
  const parts = [
    added.length &&
      `uploading ${added.map(({ fileName }) => fileName).join(", ")}`,
    removed.length && `deleting ${removed.length}`,
    "ordering them as listed",
  ].filter(Boolean);
  announce(
    sync,
    changes,
    `Setting the ${type} screenshots: ${parts.join(", ")}`,
  );
  if (!sync.apply) return;
  if (!localization)
    throw new Error(
      "App Store Connect has no localization for the screenshots.",
    );
  if (!set)
    set = (
      await api.post<One<Attributes>>("/v1/appScreenshotSets", {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: type },
          relationships: {
            appStoreVersionLocalization: link(
              "appStoreVersionLocalizations",
              localization,
            ),
          },
        },
      })
    ).data.id;
  for (const shot of removed) await api.delete(`/v1/appScreenshots/${shot.id}`);
  const ids = new Map([...kept].map(([checksum, shot]) => [checksum, shot.id]));
  for (const file of added)
    ids.set(file.checksum, await uploadScreenshot(api, sync, set, file));
  await api.patch(`/v1/appScreenshotSets/${set}/relationships/appScreenshots`, {
    data: files.map((file) => ({
      type: "appScreenshots",
      id: ids.get(file.checksum)!,
    })),
  });
  const stored = await every<ScreenshotAttributes>(
    api,
    query(`/v1/appScreenshotSets/${set}/appScreenshots`, screenshotFields),
  );
  if (
    stored.length !== files.length ||
    files.some(
      (file, index) =>
        stored[index]!.attributes.sourceFileChecksum !== file.checksum ||
        !done(stored[index]!),
    )
  )
    throw new Error(
      `App Store Connect does not list the ${type} screenshots as the listing has them. Run this again.`,
    );
}

// Reserves the screenshot, sends its parts where App Store Connect says,
// commits it with its checksum, and waits for Apple to process it.
async function uploadScreenshot(
  api: AppStoreConnect,
  { sleep, timeout, interval = 5_000, log }: Sync,
  set: string,
  file: Screenshot,
) {
  log(`==> Uploading ${file.fileName}`);
  const reserved = (
    await api.post<One<{ uploadOperations: UploadOperation[] | null }>>(
      "/v1/appScreenshots",
      {
        data: {
          type: "appScreenshots",
          attributes: { fileName: file.fileName, fileSize: file.bytes.length },
          relationships: { appScreenshotSet: link("appScreenshotSets", set) },
        },
      },
    )
  ).data;
  for (const operation of reserved.attributes.uploadOperations ?? [])
    await api.upload(operation, file.bytes);
  await api.patch(`/v1/appScreenshots/${reserved.id}`, {
    data: {
      type: "appScreenshots",
      id: reserved.id,
      attributes: { uploaded: true, sourceFileChecksum: file.checksum },
    },
  });
  for (let waited = 0; ; waited += interval) {
    const state = (
      await api.get<One<ScreenshotAttributes>>(
        query(`/v1/appScreenshots/${reserved.id}`, {
          "fields[appScreenshots]": "assetDeliveryState",
        }),
      )
    ).data.attributes.assetDeliveryState;
    if (state?.state === "COMPLETE") return reserved.id;
    if (state?.state === "FAILED")
      throw new Error(
        `App Store Connect could not process ${file.fileName}: ${(state.errors ?? []).map(({ code, description }) => [code, description].filter(Boolean).join(": ")).join("; ") || "no details"}.`,
      );
    if (waited + interval > timeout)
      throw new Error(
        `App Store Connect did not finish processing ${file.fileName} in ${Math.round(timeout / 1000)} seconds. Run this again, which replaces it if it is still unfinished.`,
      );
    await sleep(interval);
  }
}

// The client for a dry run, which refuses every request that could change
// App Store Connect, so a bug in the sync can't write during one.
export function readOnly(api: AppStoreConnect): AppStoreConnect {
  const refuse = async (): Promise<never> => {
    throw new Error("A dry run tried to change App Store Connect.");
  };
  return {
    ...api,
    post: refuse,
    patch: refuse,
    delete: refuse,
    upload: refuse,
  };
}
