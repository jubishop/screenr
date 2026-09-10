import { expect, type Locator } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

test("spoiler reveal labels have readable contrast and protect discussions and comments", async ({
  member,
}, testInfo) => {
  const owner = await member("spoilerowner");
  const reader = await member("spoilerreader");
  await prepareFriendship(owner, reader);
  await owner.goto("/titles/movie/987654");
  const post = async (action: string, data: object) => {
    const response = await owner.request.post(`/api/screenr/${action}`, {
      headers: { Origin: browserConfig.baseURL },
      data,
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  };
  const discussion = await post("title-comment", {
    title: "movie:987654",
    body: "The visitor is the missing lighthouse keeper.",
    spoiler: true,
  });
  await post("comment", {
    conversation: discussion,
    body: "The final scene explains the light.",
    spoiler: false,
  });
  const reply = await post("comment", {
    conversation: discussion,
    body: "The keeper leaves again at dawn.",
    spoiler: true,
  });
  const readable = async (button: Locator, name: string) => {
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    const colors = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      const rgb = (value: string) => {
        const channels = value.match(/[\d.]+/g)!.map(Number);
        if (channels.length !== 3 && channels[3] !== 1)
          throw new Error(
            `Contrast measurement needs an opaque color: ${value}`,
          );
        return channels.slice(0, 3);
      };
      // These controls paint a solid background. Reject effects that would
      // make their computed foreground/background pair an invalid measurement.
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const ancestor = getComputedStyle(node);
        if (ancestor.opacity !== "1" || ancestor.filter !== "none")
          throw new Error(
            "Contrast measurement needs fully opaque, unfiltered controls",
          );
      }
      if (style.backgroundImage !== "none")
        throw new Error("Contrast measurement needs a solid background");
      const luminance = (value: string) => {
        const [r, g, b] = rgb(value).map((channel) => {
          const s = channel / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return {
        color: style.color,
        background: style.backgroundColor,
        ratio:
          (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05),
      };
    });
    await testInfo.attach(name, {
      body: JSON.stringify(colors),
      contentType: "application/json",
    });
    expect.soft(colors.ratio, name).toBeGreaterThanOrEqual(4.5);
  };
  for (const width of [390, 1440]) {
    await reader.setViewportSize({ width, height: 900 });
    for (const path of ["/titles/movie/987654", "/", "/people/spoilerowner"]) {
      await reader.goto(path);
      const item = reader.locator(`[data-item-id="${discussion}"]`);
      const hiddenDiscussion = item.getByText(
        "The visitor is the missing lighthouse keeper.",
        { exact: true },
      );
      const inheritedReply = item.getByText(
        "The final scene explains the light.",
        { exact: true },
      );
      const hiddenReply = item.getByText("The keeper leaves again at dawn.", {
        exact: true,
      });
      await expect(hiddenDiscussion).toHaveCount(0);
      await expect(inheritedReply).toHaveCount(0);
      await expect(hiddenReply).toHaveCount(0);
      const revealDiscussion = item.getByRole("button", {
        name: "Contains spoilers · Reveal discussion",
        exact: true,
      });
      await readable(revealDiscussion, `discussion ${width} ${path}`);
      if (path === "/titles/movie/987654")
        await reader.screenshot({
          path: testInfo.outputPath(`discussion-${width}.png`),
          fullPage: true,
        });
      await revealDiscussion.click();
      await expect(hiddenDiscussion).toBeVisible();
      await expect(inheritedReply).toBeVisible();
      await expect(hiddenReply).toHaveCount(0);
      const revealComment = item
        .locator(`[data-comment-id="${reply}"]`)
        .getByRole("button", {
          name: "Contains spoilers · Reveal comment",
          exact: true,
        });
      await readable(revealComment, `comment ${width} ${path}`);
      if (path === "/titles/movie/987654")
        await reader.screenshot({
          path: testInfo.outputPath(`comment-${width}.png`),
          fullPage: true,
        });
      await revealComment.focus();
      await revealComment.press("Enter");
      await expect(hiddenReply).toBeVisible();
      await expect(revealDiscussion).toHaveCount(0);
      await expect(revealComment).toHaveCount(0);
    }
  }
  await owner.context().close();
  await reader.context().close();
});

test("spoiler reply links reach the hidden discussion before revealing the target", async ({
  member,
}) => {
  const page = await member("commentlinks");
  const headers = { Origin: browserConfig.baseURL };
  const body = "Hidden discussion.\n".repeat(60).trim();
  const response = await page.request.post("/api/screenr/title-comment", {
    headers,
    data: { title: "movie:987655", body, spoiler: true },
  });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  const replyResponse = await page.request.post("/api/screenr/comment", {
    headers,
    data: { conversation: id, body: "Linked hidden reply", spoiler: false },
  });
  expect(replyResponse.ok()).toBe(true);
  const { id: replyId } = await replyResponse.json();
  // Newer entries put the linked discussion below the initial viewport.
  for (let index = 0; index < 2; index++) {
    const newer = await page.request.post("/api/screenr/title-comment", {
      headers,
      data: {
        title: "movie:987655",
        body: `Newer discussion ${index}`,
        spoiler: false,
      },
    });
    expect(newer.ok()).toBe(true);
  }
  await page.goto(`/titles/movie/987655?item=${id}&reply=${replyId}`);
  const item = page.locator(`[data-item-id="${id}"]`);
  const reveal = item.getByRole("button", {
    name: "Contains spoilers · Reveal discussion",
    exact: true,
  });
  await expect(reveal).toBeInViewport();
  await expect(item.getByText(body, { exact: true })).toHaveCount(0);
  await expect(
    item.getByText("Linked hidden reply", { exact: true }),
  ).toHaveCount(0);
  await reveal.click();
  await expect(page.locator(`#comment-${replyId}`)).toBeInViewport();
  await expect(
    item.getByText("Linked hidden reply", { exact: true }),
  ).toBeVisible();
  await page.context().close();
});
