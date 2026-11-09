import { expect, type Page } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship, userId } from "./member-fixture";
import { expectThemedPage } from "./contrast";
import { failOneRead, openWithoutPolling, readAgain } from "./refresh-helpers";

// Members' reports and the owner's review page
// (docs/data-and-access.md#content-reports). The browser server names
// reviewowner.browser@example.test as the owner.

async function post(page: Page, action: string, data: unknown) {
  const response = await page.request.post(`/api/screenr/${action}`, {
    headers: { Origin: browserConfig.baseURL },
    data,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).id as string;
}

// The writes a page sends to each action.
function writes(page: Page) {
  const sent: { action: string; body: unknown }[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && pathname.startsWith("/api/screenr/"))
      sent.push({
        action: pathname.slice("/api/screenr/".length),
        body: request.postDataJSON(),
      });
  });
  return (action: string) =>
    sent.filter((write) => write.action === action).map(({ body }) => body);
}

test("members report posts, comments, and reviews from the feed, which then leave their feed, and can block the author", async ({
  member,
}) => {
  const reporter = await member("reportreader");
  const author = await member("reportauthor", { displayName: "Rex Rude" });
  await prepareFriendship(reporter, author);
  const own = await post(reporter, "discussion-post", {
    body: "My own movie night",
    spoiler: false,
  });
  const reply = await post(author, "comment", {
    conversation: own,
    body: "A rude reply",
    spoiler: false,
  });
  const rudePost = await post(author, "discussion-post", {
    body: "A rude post",
    spoiler: false,
  });
  const review = await post(author, "review", {
    title: "movie:987654",
    rating: 1,
    body: "A rude review",
    spoiler: false,
  });
  const sent = writes(reporter);
  await reporter.goto("/");

  // The reader's own entries offer no Report.
  const mine = reporter.locator(`[data-item-heading="${own}"]`);
  await expect(mine).toBeVisible();
  await expect(mine.getByRole("button", { name: /^Report/ })).toHaveCount(0);

  // A comment: the form opens beneath it with the first reason focused.
  const comment = reporter.locator(`[data-comment-id="${reply}"]`);
  await comment.getByRole("button", { name: "Report", exact: true }).click();
  let form = comment.getByRole("form", { name: "Report this comment" });
  await expect(
    form.getByRole("radio", { name: "Harassment or bullying" }),
  ).toBeFocused();
  await expect(form).toContainText(
    "Screenr’s owner reviews every report within 24 hours. You won’t see this comment anymore.",
  );
  // Reporting without a reason shows the server's message.
  await form.getByRole("button", { name: "Report", exact: true }).click();
  await expect(form).toContainText("Choose why you’re reporting it.");
  await form.getByRole("radio", { name: "Spam" }).check();
  await form
    .getByLabel("Add details (optional)")
    .fill("  Keeps posting this.  ");
  await form.getByRole("button", { name: "Report", exact: true }).click();
  const offer = (page: Page) =>
    page.getByRole("group", { name: /^Thanks for reporting/ });
  await expect(offer(reporter)).toContainText(
    "Thanks for reporting. Screenr’s owner will review it. Block Rex Rude too?",
  );
  await expect(
    offer(reporter).getByRole("button", { name: "Not now", exact: true }),
  ).toBeFocused();
  await expect(reporter.getByText("A rude reply")).toHaveCount(0);
  await offer(reporter)
    .getByRole("button", { name: "Not now", exact: true })
    .click();
  await expect(offer(reporter)).toHaveCount(0);

  // A post, from its flag button; Cancel returns focus to it.
  const rude = reporter.locator(`[data-item-heading="${rudePost}"]`);
  const flag = rude.getByRole("button", { name: "Report post", exact: true });
  await flag.click();
  form = rude.getByRole("form", { name: "Report this post" });
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(flag).toBeFocused();
  await flag.click();
  await form.getByRole("radio", { name: "Hate or discrimination" }).check();
  await form.getByRole("button", { name: "Report", exact: true }).click();
  await expect(offer(reporter)).toBeVisible();
  await expect(
    reporter.locator(`[data-item-id="${rudePost}"] .comment-body`),
  ).toHaveCount(0);
  await offer(reporter)
    .getByRole("button", { name: "Not now", exact: true })
    .click();

  // A review on its title page, where Block hides the author everywhere.
  await reporter.goto("/titles/movie/987654");
  const reviewed = reporter.locator(`[data-item-heading="${review}"]`);
  await reviewed
    .getByRole("button", { name: "Report review", exact: true })
    .click();
  form = reviewed.getByRole("form", { name: "Report this review" });
  await form.getByRole("radio", { name: "Something else" }).check();
  await form.getByRole("button", { name: "Report", exact: true }).click();
  await offer(reporter)
    .getByRole("button", { name: "Block", exact: true })
    .click();
  await expect(offer(reporter)).toHaveCount(0);
  await expect(reporter.getByText("A rude review")).toHaveCount(0);

  // The first try had no reason.
  expect(sent("report")).toEqual([
    { item: own, reply },
    {
      item: own,
      reply,
      reason: "spam",
      note: "Keeps posting this.",
    },
    { item: rudePost, reason: "hate" },
    { item: review, reason: "other" },
  ]);
  expect(sent("relationship")).toEqual([
    { target: await userId(author), action: "block" },
  ]);
  // The author still sees their own post.
  await author.goto("/");
  await expect(author.getByText("A rude post")).toBeVisible();
});

test("an open report form keeps its choices through a failed read and sends after the next one", async ({
  member,
}) => {
  const reporter = await member("reportkeeper");
  const author = await member("reportkept", { displayName: "Kim Kept" });
  await prepareFriendship(reporter, author);
  const own = await post(reporter, "discussion-post", {
    body: "Keeper's post",
    spoiler: false,
  });
  const reply = await post(author, "comment", {
    conversation: own,
    body: "Kept reply",
    spoiler: false,
  });
  const entry = await post(author, "discussion-post", {
    body: "Kept post",
    spoiler: false,
  });
  await openWithoutPolling(reporter, "/");
  for (const [container, open, name] of [
    [
      reporter.locator(`[data-comment-id="${reply}"]`),
      { name: "Report", exact: true },
      "Report this comment",
    ],
    [
      reporter.locator(`[data-item-heading="${entry}"]`),
      { name: "Report post", exact: true },
      "Report this post",
    ],
  ] as const) {
    await container.getByRole("button", open).click();
    const form = reporter.getByRole("form", { name });
    await form.getByRole("radio", { name: "Violence or threats" }).check();
    await form.getByLabel("Add details (optional)").fill("Still here.");
    await failOneRead(reporter);
    await expect(reporter.getByText("Kept post")).toHaveCount(0);
    await expect(
      form.getByRole("radio", { name: "Violence or threats" }),
    ).toBeChecked();
    await expect(form.getByLabel("Add details (optional)")).toHaveValue(
      "Still here.",
    );
    await readAgain(reporter);
    await form.getByRole("button", { name: "Report", exact: true }).click();
    const offer = reporter.getByRole("group", {
      name: /^Thanks for reporting/,
    });
    await offer.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(offer).toHaveCount(0);
  }
  await refreshAndCheck(reporter, ["Kept reply", "Kept post"]);
});

// After a read, none of `texts` shows.
async function refreshAndCheck(page: Page, texts: string[]) {
  await readAgain(page);
  for (const text of texts) await expect(page.getByText(text)).toHaveCount(0);
}

test("members report a profile from More actions and can block from the offer", async ({
  member,
}) => {
  const reporter = await member("profilereporter");
  await member("profilereported", { displayName: "Nora Nasty" });
  const sent = writes(reporter);
  await reporter.goto("/people/profilereported");
  await reporter
    .getByRole("button", { name: "More actions for Nora Nasty" })
    .click();
  await reporter.getByRole("menuitem", { name: "Report", exact: true }).click();
  const form = reporter.getByRole("form", {
    name: "Report Nora Nasty’s profile",
  });
  await expect(form).toContainText(
    "Screenr’s owner reviews every report within 24 hours.",
  );
  await expect(form).not.toContainText("anymore");
  await form.getByRole("radio", { name: "Sexual content" }).check();
  await form.getByRole("button", { name: "Report", exact: true }).click();
  const offer = reporter.getByRole("group", { name: /^Thanks for reporting/ });
  // The profile stays; Block opens Friends with its notice.
  await expect(
    reporter.getByRole("heading", { level: 1, name: "Nora Nasty" }),
  ).toBeVisible();
  await offer.getByRole("button", { name: "Block", exact: true }).click();
  await expect(reporter).toHaveURL(/\/people$/);
  await expect(
    reporter.getByText("You blocked Nora Nasty.", { exact: true }),
  ).toBeFocused();
  expect(sent("report")).toEqual([
    { person: expect.any(String), reason: "sexual" },
  ]);
});

test("only the owner reaches the review page, where Remove and Dismiss resolve reports", async ({
  member,
  page: visitor,
}) => {
  const owner = await member("reviewowner");
  const reporter = await member("reviewreporter", {
    displayName: "Rita Reporter",
  });
  const author = await member("reviewauthor", { displayName: "Al Author" });
  await prepareFriendship(reporter, author);
  const removed = await post(author, "discussion-post", {
    body: "Remove me",
    spoiler: false,
  });
  const kept = await post(author, "discussion-post", {
    body: "Keep me",
    spoiler: false,
  });
  for (const [item, reason, note] of [
    [removed, "harassment", "Targets me."],
    [kept, "spam", undefined],
  ])
    await post(reporter, "report", { item, reason, note });

  // Signed-out visitors sign in, and other members see Page not found.
  await visitor.goto("/reports");
  await expect(visitor).toHaveURL(/\/login$/);
  const response = await reporter.goto("/reports");
  expect(response?.status()).toBe(404);
  await expect(reporter.getByRole("main").locator(".error")).toContainText(
    "Page not found.",
  );
  await expect(reporter.getByText("Remove me")).toHaveCount(0);

  const reviewed = await owner.goto("/reports");
  expect(reviewed?.status()).toBe(200);
  await expect(owner).toHaveTitle("Reports · Screenr");
  await expect(
    owner.getByRole("heading", { level: 1, name: "Reports" }),
  ).toBeVisible();
  // Other specs' reports share the page, so only this author's count.
  const cards = owner
    .getByRole("article")
    .filter({ hasText: "Al Author @reviewauthor" });
  await expect(cards).toHaveCount(2);
  // Newest first, with what the reporter saw.
  await expect(cards.nth(0)).toContainText("Post by Al Author @reviewauthor");
  await expect(cards.nth(0)).toContainText("Reason: Spam");
  await expect(cards.nth(0)).toContainText("Keep me");
  for (const colorScheme of ["light", "dark"] as const) {
    await owner.emulateMedia({ colorScheme });
    await expectThemedPage(owner, `reports ${colorScheme}`);
  }
  await owner.emulateMedia({ colorScheme: "light" });
  const first = cards.filter({ hasText: "Remove me" });
  await expect(first).toContainText(
    "Reported by Rita Reporter @reviewreporter",
  );
  await expect(first).toContainText("Reason: Harassment or bullying");
  await expect(first).toContainText("Note: Targets me.");

  await first.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = first.getByRole("group", {
    name: "Remove this post? It will be hidden from everyone, including its author.",
  });
  await expect(
    confirm.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(owner.getByText("Remove me")).toHaveCount(0);
  await cards
    .filter({ hasText: "Keep me" })
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(cards).toHaveCount(0);
  await owner.reload();
  await expect(
    owner.getByRole("heading", { level: 1, name: "Reports" }),
  ).toBeVisible();
  await expect(cards).toHaveCount(0);

  // Removal hides the post from its author too; dismissal changes nothing.
  await author.goto("/");
  await expect(author.getByText("Keep me")).toBeVisible();
  await expect(author.getByText("Remove me")).toHaveCount(0);
});
