import { expect, type Locator, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { expectTextContrast } from "./contrast";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

const sections = [
  { path: "/", heading: "Your circle", current: "Your circle" },
  { path: "/search", heading: "Find a title", current: "Find a title" },
  { path: "/people", heading: "Friends", current: "Friends" },
  { path: "/invites", heading: "Invite friends", current: "Friends" },
  { path: "/account", heading: "Account", current: "Account" },
];
const shortLabels: Record<string, string> = {
  "Your circle": "Circle",
  "Find a title": "Find",
  Friends: "Friends",
  Account: "Account",
};

function navigation(page: Page) {
  return page.getByRole("navigation", { name: "Main navigation" });
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${locator} has no layout box`);
  return bounds;
}

// The element painted at the control's center is the control itself, so no
// sticky header or fixed bar covers it.
async function expectUncovered(locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return !!hit && element.contains(hit);
      }),
    )
    .toBe(true);
}

test("member pages show plain headings without decorative page chrome", async ({
  member,
}) => {
  const viewer = await member("frameviewer");
  const friend = await member("framefriend");
  await prepareFriendship(viewer, friend);
  const plain = [
    ...sections,
    { path: "/watch-together?with=framefriend", heading: "Watch together" },
  ];
  for (const [width, size] of [
    [390, 28],
    [1366, 32],
  ] as const) {
    await viewer.setViewportSize({ width, height: 844 });
    for (const { path, heading } of plain) {
      await viewer.goto(path);
      const title = viewer.getByRole("main").getByRole("heading", { level: 1 });
      await expect(title).toHaveText(heading);
      await expect(title).toHaveCSS("font-size", `${size}px`);
      await expect(viewer.locator("main .eyebrow")).toHaveCount(0);
      for (const text of [
        "YOUR PEOPLE. YOUR PICKS.",
        "A private circle",
        "Good company.",
        "Great things to watch.",
      ])
        await expect(viewer.getByText(text)).toHaveCount(0);
    }
    for (const path of [
      "/titles/movie/987654",
      "/people/framefriend",
      "/people/frameviewer",
    ]) {
      await viewer.goto(path);
      const title = viewer.getByRole("main").getByRole("heading", { level: 1 });
      await expect(title).toBeVisible();
      const titleSize = await title.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      );
      expect(titleSize, `${path} keeps its larger heading`).toBeGreaterThan(
        size,
      );
    }
  }

  await viewer.goto("/account");
  await expect(
    viewer.getByText("Fresh recommendations", { exact: false }),
  ).toHaveCount(0);
  const signIn = viewer.getByRole("region", {
    name: "Sign-in methods",
    exact: true,
  });
  await expect(signIn).toContainText(
    "Keep the same profile and friendships when you change sign-in methods.",
  );
  const profile = viewer.getByRole("region", {
    name: "Your profile",
    exact: true,
  });
  const edit = profile.getByRole("button", {
    name: "Edit profile",
    exact: true,
  });
  const view = profile.getByRole("link", {
    name: "View your profile",
    exact: true,
  });
  await expect(view).toHaveAttribute("href", "/people/frameviewer");
  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    const [editBox, viewBox] = [await box(edit), await box(view)];
    expect(Math.abs(editBox.y - viewBox.y)).toBeLessThan(2);
    expect(viewBox.x).toBeGreaterThan(editBox.x + editBox.width);
  }
  await view.click();
  await expect(viewer).toHaveURL(/\/people\/frameviewer$/);
});

test("phone navigation is a four-item bottom bar below a slim sticky header", async ({
  member,
}) => {
  const viewer = await member("framephone");
  const friend = await member("framephonefriend");
  await prepareFriendship(viewer, friend);
  const nav = navigation(viewer);
  const header = viewer.getByRole("banner");
  for (const { path, current } of sections) {
    await viewer.goto(path);
    await expect(nav.getByRole("link")).toHaveText(
      ["Circle", "Find", "Friends", "Account"],
      { useInnerText: true },
    );
    const active = nav.getByRole("link", {
      name: shortLabels[current],
      exact: true,
    });
    await expect(active).toHaveAttribute(
      "aria-current",
      path === "/invites" ? "true" : "page",
    );
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
    for (const link of await nav.getByRole("link").all()) {
      const text = await link.innerText();
      await expect(link).toHaveAccessibleName(text);
      const label = link.getByText(text, { exact: true });
      const fontSize = await label.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(12);
      await expectTextContrast(label);
      expect((await box(link)).height).toBeGreaterThanOrEqual(44);
    }
  }

  await viewer.goto("/account");
  const headerBox = await box(header);
  expect(headerBox.y).toBe(0);
  expect(headerBox.height).toBeGreaterThanOrEqual(52);
  expect(headerBox.height).toBeLessThanOrEqual(60);
  await expect(
    header.getByRole("link", { name: /^screenr/ }).first(),
  ).toBeVisible();
  await expect(
    header.getByRole("button", { name: /^Notifications/ }),
  ).toBeVisible();
  const navBox = await box(nav);
  expect(navBox.x).toBe(0);
  expect(navBox.width).toBe(390);
  expect(navBox.y + navBox.height).toBe(844);
  expect(navBox.height).toBeLessThanOrEqual(72);

  // Focusing a control that sits under the bar or the header scrolls it clear.
  const connect = viewer.getByRole("button", {
    name: "Connect Google",
    exact: true,
  });
  const signOut = viewer.getByRole("button", { name: "Sign out", exact: true });
  await signOut.evaluate((element) =>
    window.scrollBy(
      0,
      element.getBoundingClientRect().bottom - (window.innerHeight - 4),
    ),
  );
  await connect.evaluate((element: HTMLElement) =>
    element.focus({ preventScroll: true }),
  );
  await viewer.keyboard.press("Tab");
  await expect(signOut).toBeFocused();
  await expectUncovered(signOut);
  const edit = viewer.getByRole("button", {
    name: "Edit profile",
    exact: true,
  });
  const view = viewer.getByRole("link", {
    name: "View your profile",
    exact: true,
  });
  await edit.evaluate((element) =>
    window.scrollBy(0, element.getBoundingClientRect().top - 4),
  );
  await view.evaluate((element: HTMLElement) =>
    element.focus({ preventScroll: true }),
  );
  await viewer.keyboard.press("Shift+Tab");
  await expect(edit).toBeFocused();
  await expectUncovered(edit);
  // Focusing the header and bar controls leaves the reading position alone.
  await viewer.evaluate(() => window.scrollTo(0, 300));
  const reading = await viewer.evaluate(() => window.scrollY);
  expect(reading).toBe(300);
  for (const control of [
    header.getByRole("link", { name: /^screenr/ }),
    header.getByRole("button", { name: /^Notifications/ }),
    nav.getByRole("link", { name: "Circle", exact: true }),
    nav.getByRole("link", { name: "Account", exact: true }),
  ]) {
    await control.evaluate((element: HTMLElement) => element.focus());
    await expect(control).toBeFocused();
    expect(await viewer.evaluate(() => window.scrollY)).toBe(reading);
  }

  // Scrolled to the end, the last control clears the bar and both stay fixed.
  await viewer.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  expect(await viewer.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expectUncovered(signOut);
  expect((await box(header)).y).toBe(0);
  const scrolledNav = await box(nav);
  expect(scrolledNav.y + scrolledNav.height).toBe(844);
  expect(
    await viewer.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // The New activity control stays below the header on a scrolled feed.
  for (let index = 0; index < 4; index++) {
    const posted = await friend.request.post("/api/screenr/title-comment", {
      headers: { Origin: browserConfig.baseURL },
      data: {
        title: "movie:987654",
        body: `Frame discussion ${index}\n\nWith a second paragraph.`,
        spoiler: false,
      },
    });
    expect(posted.status()).toBe(200);
  }
  await viewer.goto("/");
  await expect(viewer.locator("[data-item-id]")).toHaveCount(4);
  await viewer.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const posted = await friend.request.post("/api/screenr/title-comment", {
    headers: { Origin: browserConfig.baseURL },
    data: { title: "movie:987654", body: "Arriving later", spoiler: false },
  });
  expect(posted.status()).toBe(200);
  const update = viewer.getByRole("button", { name: /New activity/ });
  await expect(update).toBeVisible();
  expect((await box(update)).y).toBeGreaterThanOrEqual(headerBox.height);
  await expectUncovered(update);
  const last = viewer.locator("[data-item-id]").last();
  await expectUncovered(last.getByRole("button", { name: "Comment" }));
});

test("navigation moves between the four sections and opens invitations from Friends", async ({
  member,
}) => {
  const viewer = await member("framedesk");
  await viewer.setViewportSize({ width: 1366, height: 900 });
  const nav = navigation(viewer);
  await expect(nav.getByRole("link")).toHaveText(
    ["Your circle", "Find a title", "Friends", "Account"],
    { useInnerText: true },
  );
  for (const label of Object.keys(shortLabels))
    await expect(
      nav.getByRole("link", { name: label, exact: true }),
    ).toHaveAccessibleName(label);
  const navBox = await box(nav);
  const mainBox = await box(viewer.getByRole("main"));
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(mainBox.x);
  await expect(
    viewer.getByRole("link", { name: "Invite friends" }),
  ).toHaveCount(0);

  // Keyboard order: skip link, logo, notifications, then the four sections.
  await viewer.evaluate(() => (document.activeElement as HTMLElement).blur());
  await viewer.keyboard.press("Tab");
  await expect(
    viewer.getByRole("link", { name: "Skip to main content", exact: true }),
  ).toBeFocused();
  await viewer.keyboard.press("Tab");
  await expect(viewer.getByRole("link", { name: /^screenr/ })).toBeFocused();
  await viewer.keyboard.press("Tab");
  await expect(
    viewer.getByRole("button", { name: /^Notifications/ }),
  ).toBeFocused();
  for (const label of ["Your circle", "Find a title", "Friends"]) {
    await viewer.keyboard.press("Tab");
    const link = nav.getByRole("link", { name: label, exact: true });
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS("outline-style", "solid");
  }
  await viewer.keyboard.press("Enter");
  await expect(viewer).toHaveURL(/\/people$/);
  await expect(
    viewer.getByRole("heading", { level: 1, name: "Friends", exact: true }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Friends", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);

  const invite = viewer
    .getByRole("main")
    .getByRole("link", { name: "Invite friends", exact: true });
  for (const width of [1366, 390]) {
    await viewer.setViewportSize({ width, height: 844 });
    const inviteBox = await box(invite);
    const search = await box(viewer.getByLabel("Exact username"));
    expect(inviteBox.y).toBeLessThan(search.y);
    await expect(invite).toHaveClass(/primary/);
  }
  await viewer.setViewportSize({ width: 1366, height: 900 });
  await invite.click();
  await expect(viewer).toHaveURL(/\/invites$/);
  await expect(
    viewer.getByRole("heading", { level: 1, name: "Invite friends" }),
  ).toBeVisible();
  await expect(
    viewer.getByText("Your link works for 30 days", { exact: false }),
  ).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "Friends", exact: true }),
  ).toHaveAttribute("aria-current", "true");

  for (const { path, heading, current } of sections.filter(
    ({ path }) => path !== "/invites",
  )) {
    await nav.getByRole("link", { name: current, exact: true }).click();
    await expect(viewer).toHaveURL(new RegExp(`${path}$`));
    await expect(
      viewer.getByRole("heading", { level: 1, name: heading, exact: true }),
    ).toBeVisible();
    await expect(
      nav.getByRole("link", { name: current, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  await viewer.goto("/titles/movie/987654");
  await expect(nav.locator("[aria-current]")).toHaveCount(0);
});

test("each member page has its own title, and navigation focuses its heading", async ({
  member,
}) => {
  const viewer = await member("titledviewer", { displayName: "Titled Viewer" });
  const friend = await member("titledfriend", { displayName: "Titled Friend" });
  await prepareFriendship(viewer, friend);
  const named: [string, string][] = [
    ...sections.map(({ path, heading }): [string, string] => [path, heading]),
    ["/watch-together?with=titledfriend", "Watch together"],
    ["/titles/movie/987654", "The Lantern Room"],
    ["/people/titledfriend", "Titled Friend"],
    ["/people/titledviewer", "Titled Viewer"],
  ];
  for (const [path, name] of named) {
    // The server renders the title, so tabs and history name the page before
    // any script runs.
    const html = await (await viewer.request.get(path)).text();
    expect(html.match(/<title>[^<]*<\/title>/g), path).toEqual([
      `<title>${name} · Screenr</title>`,
    ]);
    expect(html.indexOf("<title>")).toBeLessThan(html.indexOf("</head>"));
    await viewer.goto(path);
    await expect(viewer).toHaveTitle(`${name} · Screenr`);
    // A full page load leaves focus where the browser puts it.
    expect(
      await viewer.evaluate(() => document.activeElement === document.body),
      path,
    ).toBe(true);
  }

  const nav = navigation(viewer);
  const main = viewer.getByRole("main");
  const heading = (name: string) =>
    main.getByRole("heading", { level: 1, name, exact: true });
  const search = viewer.getByLabel("Movie or show title", { exact: true });
  for (const width of [1366, 390]) {
    await viewer.setViewportSize({ width, height: 844 });
    await viewer.goto("/");
    // Choosing a section from the keyboard moves focus to the new heading, so
    // the next Tab continues in the page instead of the navigation.
    await nav
      .getByRole("link", { name: width > 560 ? "Find a title" : "Find" })
      .focus();
    await viewer.keyboard.press("Enter");
    await expect(viewer).toHaveURL(/\/search$/);
    await expect(viewer).toHaveTitle("Find a title · Screenr");
    await expect(heading("Find a title")).toBeFocused();
    // Next's route announcer reads the new title aloud.
    await expect(viewer.locator("#__next-route-announcer__")).toHaveText(
      "Find a title · Screenr",
    );
    expect(
      await viewer.evaluate(() => document.querySelectorAll("title").length),
    ).toBe(1);
    await viewer.keyboard.press("Tab");
    await expect(search).toBeFocused();

    // Background refreshes keep focus and the draft where the reader left them.
    await search.fill("Lantern");
    const refreshed = viewer.waitForResponse((response) =>
      response.url().includes("/api/screenr/screen?"),
    );
    await viewer.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Lantern");
    await expect(viewer).toHaveTitle("Find a title · Screenr");

    // Links inside a page, and Back, focus the heading they open.
    await nav.getByRole("link", { name: "Friends", exact: true }).click();
    await expect(heading("Friends")).toBeFocused();
    await expect(viewer).toHaveTitle("Friends · Screenr");
    await main.getByRole("link", { name: /^Titled Friend/ }).click();
    await expect(viewer).toHaveURL(/\/people\/titledfriend$/);
    await expect(heading("Titled Friend")).toBeFocused();
    await expect(viewer).toHaveTitle("Titled Friend · Screenr");
    await viewer.goBack();
    await expect(viewer).toHaveURL(/\/people$/);
    await expect(heading("Friends")).toBeFocused();
    await expect(viewer).toHaveTitle("Friends · Screenr");
    // The focused heading is in view below the phone header.
    await expect(heading("Friends")).toBeInViewport();
    await expectUncovered(heading("Friends"));
  }

  // A missing page is titled as missing, and its main region takes focus.
  // Next's router navigates as in-app links and notifications do.
  await viewer.evaluate(() =>
    (
      window as unknown as { next: { router: { push(path: string): void } } }
    ).next.router.push("/people/nobodyhere"),
  );
  await expect(main.getByText("Person not found.")).toBeVisible();
  await expect(viewer).toHaveTitle("Page not found · Screenr");
  await expect(main).toBeFocused();
  await viewer.goBack();
  await expect(heading("Friends")).toBeFocused();

  // Renaming yourself renames your profile's title without a navigation.
  await viewer
    .getByRole("banner")
    .getByRole("link", { name: "Your profile", exact: true })
    .click();
  await expect(heading("Titled Viewer")).toBeFocused();
  await viewer
    .getByRole("button", { name: "Edit display name", exact: true })
    .click();
  await viewer.getByLabel("Display name", { exact: true }).fill("Renamed");
  await viewer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(heading("Renamed")).toBeVisible();
  await expect(viewer).toHaveTitle("Renamed · Screenr");
  await nav.getByRole("link", { name: "Account", exact: true }).click();
  await expect(viewer).toHaveTitle("Account · Screenr");
  await viewer.goBack();
  await expect(viewer).toHaveTitle("Renamed · Screenr");
  expect(
    await viewer.evaluate(() => document.querySelectorAll("title").length),
  ).toBe(1);
});

test("a skip link moves keyboard focus past the navigation to the page", async ({
  member,
}) => {
  const viewer = await member("skipreader");
  const skip = viewer.getByRole("link", {
    name: "Skip to main content",
    exact: true,
  });
  const main = viewer.getByRole("main");
  for (const width of [390, 1366]) {
    await viewer.setViewportSize({ width, height: 844 });
    await viewer.goto("/search");
    // The link stays out of sight until keyboard focus reaches it.
    expect((await box(skip)).width).toBeLessThanOrEqual(1);
    await viewer.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    expect((await box(skip)).height).toBeGreaterThanOrEqual(44);
    for (const colorScheme of ["dark", "light"] as const) {
      await viewer.emulateMedia({ colorScheme });
      await expectTextContrast(skip);
    }
    await expectUncovered(skip);
    await viewer.keyboard.press("Enter");
    await expect(main).toBeFocused();
    await expect(viewer).toHaveURL(/\/search$/);
    await viewer.keyboard.press("Tab");
    await expect(
      viewer.getByLabel("Movie or show title", { exact: true }),
    ).toBeFocused();
    // The main region takes focus only from the link, not from later clicks.
    await expect(main).not.toHaveAttribute("tabindex");
    expect((await box(skip)).width).toBeLessThanOrEqual(1);
  }
});
