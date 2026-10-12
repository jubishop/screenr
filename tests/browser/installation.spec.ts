import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { expectTextContrast, expectThemedPage } from "./contrast";
import { test } from "./monitored-test";

const themeColor = "#f7f6f0";

// Every icon the page declares loads as an image for a signed-out visitor.
async function expectInstallableHead(page: Page, request: APIRequestContext) {
  const head = page.locator("head");
  await expect(head.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  // Form controls and the browser's interface follow the device's theme. Each
  // scheme's theme color is that theme's page color.
  await expect(head.locator('meta[name="color-scheme"]')).toHaveAttribute(
    "content",
    "light dark",
  );
  await expect(head.locator('meta[name="theme-color"]')).toHaveCount(2);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const paper = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--paper")
        .trim(),
    );
    expect(paper).toBe(colorScheme === "light" ? themeColor : "#0f1a17");
    await expect(
      head.locator(
        `meta[name="theme-color"][media="(prefers-color-scheme: ${colorScheme})"]`,
      ),
    ).toHaveAttribute("content", paper);
  }
  await expect(
    head.locator('meta[name="apple-mobile-web-app-title"]'),
  ).toHaveAttribute("content", "Screenr");
  const icons = await head
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) =>
      links.map((link) => ({
        rel: link.getAttribute("rel"),
        href: link.getAttribute("href")!,
        type: link.getAttribute("type"),
      })),
    );
  expect(icons.map(({ rel, type }) => `${rel} ${type}`).sort()).toEqual([
    "apple-touch-icon image/png",
    "icon image/svg+xml",
    "icon image/x-icon",
  ]);
  for (const { href, type } of icons) {
    const response = await request.get(href, { maxRedirects: 0 });
    expect(response.status(), href).toBe(200);
    expect(response.headers()["content-type"], href).toBe(type);
  }
}

// Decodes an icon in the browser and reports its size, its corner alpha, and
// whether every pixel outside the maskable safe zone shows the tile color.
function inspectIcon(page: Page, src: string) {
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    let opaque = true,
      plainOutsideSafeZone = true;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] !== 255) opaque = false;
        const distance = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
        if (
          distance > width * 0.4 &&
          (Math.abs(data[i] - 0x16) > 2 ||
            Math.abs(data[i + 1] - 0x3c) > 2 ||
            Math.abs(data[i + 2] - 0x34) > 2)
        )
          plainOutsideSafeZone = false;
      }
    return {
      width,
      height,
      cornerAlpha: data[3],
      opaque,
      plainOutsideSafeZone,
    };
  }, src);
}

test("sign-in and member pages declare the manifest, icons, color schemes, and theme colors", async ({
  page,
  request,
  member,
}) => {
  await page.goto("/login");
  await expectInstallableHead(page, request);
  const viewer = await member("installviewer");
  await expectInstallableHead(viewer, request);
});

test("the manifest and icons load for signed-out visitors outside the member route", async ({
  page,
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest", {
    maxRedirects: 0,
  });
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toBe("application/manifest+json");
  const body = await manifest.json();
  expect(body).toMatchObject({
    name: "Screenr",
    short_name: "Screenr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: themeColor,
  });
  expect(
    body.icons.map(
      (icon: { sizes: string; purpose?: string }) =>
        `${icon.sizes} ${icon.purpose ?? "any"}`,
    ),
  ).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);

  // Browsers and link previews request these paths without reading the page.
  for (const [path, type] of [
    ["/favicon.ico", "image/x-icon"],
    ["/apple-touch-icon.png", "image/png"],
    ["/apple-touch-icon-precomposed.png", "image/png"],
    ...body.icons.map(({ src }: { src: string }) => [src, "image/png"]),
  ]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toBe(type);
  }

  await page.goto("/login");
  for (const icon of body.icons) {
    const size = Number(icon.sizes.split("x")[0]);
    const details = await inspectIcon(page, icon.src);
    expect(details, icon.src).toMatchObject({ width: size, height: size });
    if (icon.purpose === "maskable")
      expect(details, icon.src).toMatchObject({
        opaque: true,
        plainOutsideSafeZone: true,
      });
    // Rounded icons keep transparent corners for browsers that show them as is.
    else expect(details.cornerAlpha, icon.src).toBe(0);
  }
  // iOS fills transparent pixels with black, so its full-square icon is opaque.
  expect(await inspectIcon(page, "/apple-touch-icon.png")).toMatchObject({
    width: 180,
    height: 180,
    opaque: true,
  });
});

test("offline page loads show the offline page, and the worker caches nothing", async ({
  member,
}) => {
  const viewer = await member("offlineviewer");
  await viewer.waitForFunction(
    () => navigator.serviceWorker.controller?.state === "activated",
  );

  // Online page loads pass through the worker to the network.
  const online = await viewer.goto("/people");
  expect(online?.fromServiceWorker()).toBe(true);
  await expect(
    viewer.getByRole("heading", { name: "Friends", exact: true }),
  ).toBeVisible();

  await viewer.context().setOffline(true);
  await viewer.goto("/search");
  await expect(viewer).toHaveTitle("Offline · Screenr");
  await expect(
    viewer.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  await expectTextContrast(
    viewer.getByText("Check your connection and try again."),
  );
  await expectTextContrast(viewer.getByRole("link", { name: "Try again" }));
  for (const colorScheme of ["dark", "light"] as const) {
    await viewer.emulateMedia({ colorScheme });
    await expectThemedPage(viewer, `offline ${colorScheme}`);
    await viewer.screenshot({ path: `.cache/offline-${colorScheme}.png` });
  }
  const retried = viewer.waitForEvent("load");
  await viewer.getByRole("link", { name: "Try again" }).click();
  await retried;
  await expect(
    viewer.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  expect(new URL(viewer.url()).pathname).toBe("/search");

  await viewer.context().setOffline(false);
  await viewer.getByRole("link", { name: "Try again" }).click();
  await expect(
    viewer.getByRole("heading", { name: "Find a title", exact: true }),
  ).toBeVisible();
  expect(await viewer.evaluate(() => caches.keys())).toEqual([]);
});
