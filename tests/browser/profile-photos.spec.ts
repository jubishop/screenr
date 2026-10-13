import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { db } from "./database-fixture";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";

// A wide PNG drawn in the page: a red center square between a green band on
// the left and a blue band on the right. A center crop keeps only red.
async function widePhoto(page: Page, center: string) {
  const bytes = await page.evaluate(async (center) => {
    const canvas = new OffscreenCanvas(1200, 800);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#00ff00";
    context.fillRect(0, 0, 200, 800);
    context.fillStyle = "#0000ff";
    context.fillRect(1000, 0, 200, 800);
    context.fillStyle = center;
    context.fillRect(200, 0, 800, 800);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, center);
  return {
    name: "wide.png",
    mimeType: "image/png",
    buffer: Buffer.from(bytes),
  };
}

// A detailed 4:3 camera photo: every 2-pixel block has a random color, so a
// 512-pixel JPEG of it needs a quality below 0.46 to fit the upload limit.
async function detailedPhoto(page: Page) {
  const bytes = await page.evaluate(async () => {
    const [width, height] = [1200, 900];
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(width, height);
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) % 256;
    for (let y = 0; y < height; y += 2)
      for (let x = 0; x < width; x += 2) {
        const color = [random(), random(), random(), 255];
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          image.data.set(color, ((y + dy) * width + x + dx) * 4);
      }
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.9,
    });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return {
    name: "camera.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(bytes),
  };
}

async function choosePhoto(
  page: Page,
  button: Locator,
  file: Awaited<ReturnType<typeof widePhoto>>,
) {
  const chooser = page.waitForEvent("filechooser");
  await button.click();
  await (await chooser).setFiles(file);
}

// The loaded avatar photo's size and its corner colors.
async function shownPhoto(photo: Locator) {
  await expect
    .poll(() =>
      photo.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  return photo.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const corner = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      corners: [corner(4, 4), corner(image.naturalWidth - 5, 507)],
    };
  });
}
const near = (color: number[], expected: number[]) =>
  color.every((value, index) => Math.abs(value - expected[index]) < 40);

async function storedPhoto(user: string) {
  return (
    await db.query(
      "SELECT content_type,octet_length(image)::int AS size,version FROM profile_photo WHERE user_id=$1",
      [user],
    )
  ).rows[0];
}

test("members add, replace, and remove a profile photo on Account, and friends see it", async ({
  member,
}, testInfo) => {
  const owner = await member("photoowner", { displayName: "Photo Owner" });
  const viewer = await member("photoviewer");
  await prepareFriendship(owner, viewer);
  const ownerId = await userId(owner);
  await owner.goto("/account");
  const card = owner.getByRole("region", {
    name: "Profile photo",
    exact: true,
  });
  const status = card.getByRole("status");
  const add = card.getByRole("button", { name: "Add photo", exact: true });
  await expect(card).toContainText("Your initial shows until you add a photo.");
  await expect(
    card.getByRole("button", { name: "Remove photo", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Use my Google photo", exact: true }),
  ).toHaveCount(0);
  await expect(card.locator(".avatar")).toHaveText("P");
  await expect(card.locator('input[type="file"]')).toBeHidden();
  const header = owner.locator(".header-profile .avatar img");
  await expect(header).toHaveCount(0);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await owner.route(
    "**/api/screenr/photo",
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  await choosePhoto(owner, add, await widePhoto(owner, "#ff0000"));
  const saving = card.getByRole("button", { name: "Saving…", exact: true });
  await expect(saving).toHaveAttribute("aria-disabled", "true");
  release();
  await expect(status).toHaveText("Photo added.");
  const first = await storedPhoto(ownerId);
  expect(first.content_type).toBe("image/jpeg");
  expect(first.size).toBeLessThanOrEqual(60 * 1024);
  await expect(header).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${first.version}`,
  );
  const added = await shownPhoto(header);
  expect([added.width, added.height]).toEqual([512, 512]);
  for (const corner of added.corners)
    expect(near(corner, [255, 0, 0]), String(corner)).toBe(true);
  await expect(card).toContainText(
    "Members who can see your profile see this photo.",
  );

  // A friend sees the photo on the profile header and in their Friends list.
  await viewer.goto("/people/photoowner");
  const profilePhoto = viewer.locator(".profile-heading .avatar img");
  await expect(profilePhoto).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${first.version}`,
  );
  expect((await shownPhoto(profilePhoto)).width).toBe(512);
  await viewer.goto("/people");
  await expect(
    viewer
      .getByRole("link", { name: "Photo Owner @photoowner", exact: true })
      .locator(".avatar img"),
  ).toHaveAttribute("src", `/api/photos/${ownerId}/${first.version}`);

  const replace = card.getByRole("button", {
    name: "Replace photo",
    exact: true,
  });
  await choosePhoto(owner, replace, await widePhoto(owner, "#ffff00"));
  await expect(status).toHaveText("Photo replaced.");
  const second = await storedPhoto(ownerId);
  expect(second.version).not.toBe(first.version);
  await expect(header).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${second.version}`,
  );
  for (const corner of (await shownPhoto(header)).corners)
    expect(near(corner, [255, 255, 0]), String(corner)).toBe(true);
  expect(
    (
      await owner.request.get(`/api/photos/${ownerId}/${first.version}`)
    ).status(),
  ).toBe(404);

  // A file the browser cannot open leaves the photo unchanged.
  const chooser = owner.waitForEvent("filechooser");
  await replace.click();
  await (
    await chooser
  ).setFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a photo"),
  });
  const unopened =
    "This photo could not be opened. Choose a JPEG or PNG image. Details: open failed; text/plain, 11 bytes";
  await expect(card.getByRole("alert")).toHaveText(unopened);
  await expect(replace).toHaveAccessibleDescription(unopened);
  expect((await storedPhoto(ownerId)).version).toBe(second.version);

  for (const width of [390, 1280]) {
    await owner.setViewportSize({ width, height: 900 });
    await expect(replace).toBeVisible();
    expect(
      await owner.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await owner.screenshot({
      path: testInfo.outputPath(`account-photo-${width}.png`),
      fullPage: true,
    });
  }
  // On desktop the sidebar shows the photo beside the name.
  await expect(owner.locator(".sidebar-bottom .avatar img")).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${second.version}`,
  );

  await card.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(status).toHaveText("Photo removed.");
  await expect(add).toBeFocused();
  await expect(owner.locator(".sidebar-bottom .avatar img")).toHaveCount(0);
  await expect(owner.locator(".sidebar-bottom .avatar")).toHaveText("P");
  expect(await storedPhoto(ownerId)).toEqual({
    content_type: null,
    size: null,
    version: null,
  });
  await viewer.reload();
  await expect(
    viewer
      .getByRole("link", { name: "Photo Owner @photoowner", exact: true })
      .locator(".avatar"),
  ).toHaveText("P");
  await expect(viewer.locator(".avatar img")).toHaveCount(0);
});

test("detailed camera photos fit the upload limit, at a smaller size when no 512-pixel JPEG fits", async ({
  member,
}) => {
  const owner = await member("photodetail");
  const ownerId = await userId(owner);
  await owner.goto("/account");
  const card = owner.getByRole("region", {
    name: "Profile photo",
    exact: true,
  });
  const status = card.getByRole("status");
  const header = owner.locator(".header-profile .avatar img");
  await choosePhoto(
    owner,
    card.getByRole("button", { name: "Add photo", exact: true }),
    await detailedPhoto(owner),
  );
  await expect(status).toHaveText("Photo added.");
  const first = await storedPhoto(ownerId);
  expect(first.size).toBeLessThanOrEqual(60 * 1024);
  await expect(header).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${first.version}`,
  );
  expect((await shownPhoto(header)).width).toBe(512);

  // Safari's encoder makes larger files than Chromium's at each quality and
  // stops shrinking near its lowest quality, so a detailed photo can exceed
  // the limit at 512 pixels however low the quality goes.
  await owner.evaluate(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width === 512)
        callback(new Blob([new Uint8Array(70_000)], { type }));
      else encode.call(this, callback, type, quality);
    };
  });
  await choosePhoto(
    owner,
    card.getByRole("button", { name: "Replace photo", exact: true }),
    await detailedPhoto(owner),
  );
  await expect(status).toHaveText("Photo replaced.");
  const second = await storedPhoto(ownerId);
  expect(second.size).toBeLessThanOrEqual(60 * 1024);
  await expect(header).toHaveAttribute(
    "src",
    `/api/photos/${ownerId}/${second.version}`,
  );
  const smaller = await shownPhoto(header);
  expect([smaller.width, smaller.height]).toEqual([384, 384]);
});

test("each photo preparation failure names its step with details to copy", async ({
  member,
}) => {
  const owner = await member("photofailure");
  await owner.goto("/account");
  const card = owner.getByRole("region", {
    name: "Profile photo",
    exact: true,
  });
  const add = card.getByRole("button", { name: "Add photo", exact: true });
  const alert = card.getByRole("alert");
  const photo = await widePhoto(owner, "#ff0000");
  const file = `image/png, ${photo.buffer.length} bytes, 1200×800`;
  async function expectFailure(message: string) {
    await expect(alert).toHaveText(message);
    await expect(add).toHaveAccessibleDescription(message);
    await expect(card.locator(".avatar img")).toHaveCount(0);
  }

  // The browser returns no JPEG; trying lower qualities would not help.
  await owner.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  });
  await choosePhoto(owner, add, photo);
  await expectFailure(
    `This browser could not convert the photo. Details: encode failed; ${file}; limit 61440 bytes; 512px: 0.86=no image`,
  );

  // Every JPEG is over the limit, at every quality and size.
  await owner.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = (callback, type) =>
      callback(new Blob([new Uint8Array(70_000)], { type }));
  });
  await choosePhoto(owner, add, photo);
  const qualities = [
    0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3, 0.22, 0.14, 0.06,
  ];
  const results = [512, 384, 256]
    .map(
      (side) =>
        `${side}px: ${qualities.map((quality) => `${quality}=70000`).join(", ")}`,
    )
    .join("; ");
  await expectFailure(
    `This photo could not be made small enough. Try another. Details: encode failed; ${file}; limit 61440 bytes; ${results}`,
  );

  // The browser offers no 2D canvas context.
  await owner.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await choosePhoto(owner, add, photo);
  await expectFailure(
    `This browser could not prepare the photo. Details: canvas failed; ${file}`,
  );
});

test("setup offers an optional photo that the new profile keeps", async ({
  member,
}, testInfo) => {
  const guest = await member("photoguest", { complete: false });
  const guestId = await userId(guest);
  const photo = guest.getByRole("group", {
    name: "Profile photo (optional)",
    exact: true,
  });
  await expect(photo.locator(".avatar")).toHaveText("p");
  await guest.getByLabel("Display name", { exact: true }).fill("Guest Star");
  await expect(photo.locator(".avatar")).toHaveText("G");
  await choosePhoto(
    guest,
    photo.getByRole("button", { name: "Add photo", exact: true }),
    await widePhoto(guest, "#ff0000"),
  );
  await expect(photo.getByRole("status")).toHaveText("Photo added.");
  const { version } = await storedPhoto(guestId);
  const preview = photo.locator(".avatar img");
  await expect(preview).toHaveAttribute(
    "src",
    `/api/photos/${guestId}/${version}`,
  );
  expect((await shownPhoto(preview)).width).toBe(512);
  for (const width of [390, 1280]) {
    await guest.setViewportSize({ width, height: 900 });
    expect(
      await guest.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await guest.screenshot({
      path: testInfo.outputPath(`setup-photo-${width}.png`),
      fullPage: true,
    });
  }
  await guest.getByLabel("Username", { exact: true }).fill("photoguest");
  await guest
    .getByRole("button", { name: "Join Screenr", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", { name: "Your circle", exact: true }),
  ).toBeVisible();
  await expect(guest.locator(".header-profile .avatar img")).toHaveAttribute(
    "src",
    `/api/photos/${guestId}/${version}`,
  );
});

test("members with Google sign-in see Use my Google photo, which explains a missing picture", async ({
  member,
}) => {
  const owner = await member("photogoogle");
  // A Google account without a picture. Screenr never contacts Google here.
  await db.query(
    `INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
    VALUES($1,$2,'google',$3,now(),now())`,
    [randomUUID(), randomUUID(), await userId(owner)],
  );
  await owner.goto("/account");
  const card = owner.getByRole("region", {
    name: "Profile photo",
    exact: true,
  });
  const google = card.getByRole("button", {
    name: "Use my Google photo",
    exact: true,
  });
  await google.click();
  await expect(card.getByRole("alert")).toHaveText(
    "Your Google account has no photo to use.",
  );
  await expect(google).toHaveAccessibleDescription(
    "Your Google account has no photo to use.",
  );
  await expect(card.locator(".avatar img")).toHaveCount(0);
});
