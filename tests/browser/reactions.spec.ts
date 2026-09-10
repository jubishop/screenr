import { expect } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";
import { prepareFriendship } from "./member-fixture";

test("emoji reactions persist across feeds on entries and replies, with change, removal, and retry", async ({
  member,
}) => {
  const owner = await member("reactionowner");
  const reader = await member("reactionreader", {
    hasTouch: true,
  });
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
  const recommended = await post("activity", {
    title: "movie:987654",
    field: "recommended",
    value: true,
  });
  await post("comment", {
    conversation: recommended,
    body: "Keep the recommendation discussion when switching actions",
    spoiler: false,
  });
  const watch = await post("activity", {
    title: "movie:987654",
    field: "want_to_watch",
    value: true,
  });
  const standalone = await post("title-comment", {
    title: "movie:987654",
    body: "A discussion worth reacting to",
    spoiler: false,
  });
  const reply = await post("comment", {
    conversation: standalone,
    body: "A reply worth reacting to",
    spoiler: false,
  });
  const nested = await post("comment", {
    conversation: standalone,
    body: "A nested reply",
    spoiler: false,
    replyTo: reply,
  });
  await reader.goto("/titles/movie/987654");
  const entry = reader.locator(`[data-item-id="${standalone}"]`);
  const reactions = entry.getByRole("group", {
    name: "Reactions to entry",
    exact: true,
  });
  await expect(
    reactions.getByRole("button", { name: "React", exact: true }),
  ).toBeVisible();
  for (const group of [
    reactions,
    entry.locator(`[data-comment-id="${reply}"]`).getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ]) {
    const trigger = group.getByRole("button", { name: "React", exact: true });
    for (const focusChoice of [false, true]) {
      await expect(trigger).toBeEnabled();
      await trigger.focus();
      await reader.keyboard.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      if (focusChoice)
        await group.getByRole("button", { name: "Like", exact: true }).focus();
      await reader.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
      await expect(
        group.getByRole("button", { name: "Like", exact: true }),
      ).toHaveCount(0);
    }
  }
  for (const name of ["Like", "Love", "Care", "Haha", "Wow", "Sad", "Angry"]) {
    await reactions.getByRole("button", { name: "React", exact: true }).click();
    await reactions.getByRole("button", { name, exact: true }).click();
    await expect(
      reactions.getByRole("button", { name: `${name}: 1`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(reactions.getByRole("button", { name: /: 1$/ })).toHaveCount(
      1,
    );
    await expect(
      reactions.getByRole("button", { name: "React", exact: true }),
    ).toBeFocused();
  }
  await entry
    .getByRole("button", { name: "View 1 reply", exact: true })
    .click();
  for (const [selector, label] of [
    [`[data-item-id="${recommended}"]`, "Reactions to entry"],
    [`[data-item-id="${watch}"]`, "Reactions to entry"],
    [`[data-comment-id="${reply}"]`, "Reactions to reply"],
    [`[data-comment-id="${nested}"]`, "Reactions to reply"],
  ]) {
    const group = reader
      .locator(selector)
      .getByRole("group", { name: label, exact: true });
    await group.getByRole("button", { name: "React", exact: true }).click();
    await group.getByRole("button", { name: "Love", exact: true }).click();
    await expect(
      group.getByRole("button", { name: "Love: 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  for (const path of ["/", "/people/reactionowner", "/titles/movie/987654"]) {
    await reader.goto(path);
    await entry
      .getByRole("button", { name: "View 1 reply", exact: true })
      .click();
    await expect(
      reactions.getByRole("button", { name: "Angry: 1", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      entry
        .locator(`[data-comment-id="${nested}"]`)
        .getByRole("button", { name: "Love: 1", exact: true }),
    ).toBeVisible();
  }
  await entry.getByRole("button", { name: "Comment", exact: true }).click();
  const draft = entry.getByLabel("Add your reply");
  await draft.fill("Keep this draft while reacting");
  for (const succeeds of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const saving = new Promise<void>((resolve) => (started = resolve));
    await reader.route("**/api/screenr/reaction", async (route) => {
      started();
      await gate;
      if (succeeds) await route.continue();
      else
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Reaction failed. Please retry." }),
        });
    });
    try {
      await reactions
        .getByRole("button", { name: "Angry: 1", exact: true })
        .focus();
      await reader.keyboard.press("Enter");
      await saving;
      await draft.fill("Typing while the reaction saves");
      release();
      if (succeeds) {
        await expect(
          reactions.getByRole("button", { name: "Angry: 1", exact: true }),
        ).toHaveCount(0);
      } else {
        await expect(reactions.getByRole("alert")).toHaveText(
          "Reaction failed. Please retry.",
        );
        await expect(
          reactions.getByRole("button", { name: "Angry: 1", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      }
      await expect(
        reactions.getByRole("button", { name: "React", exact: true }),
      ).toHaveAttribute("aria-disabled", "false");
      await expect(draft).toBeFocused();
      await reader.keyboard.type(" and keeps typing");
      await expect(draft).toHaveValue(
        "Typing while the reaction saves and keeps typing",
      );
    } finally {
      release();
      await reader.unroute("**/api/screenr/reaction");
    }
  }
  await reader.reload();
  await expect(
    reactions.getByRole("button", { name: "Angry: 1", exact: true }),
  ).toHaveCount(0);
  await owner.goto("/titles/movie/987654");
  await expect(
    owner
      .locator(`[data-item-id="${recommended}"]`)
      .getByRole("button", { name: "Love: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  for (const width of [320, 1440]) {
    await reader.setViewportSize({ width, height: 900 });
    await reactions.getByRole("button", { name: "React", exact: true }).click();
    expect(
      await reader.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await reader.screenshot({
      path: `.cache/reactions-${width}.png`,
      fullPage: true,
    });
    await reactions.getByRole("button", { name: "React", exact: true }).click();
  }
  await post("remove-comment", { id: standalone });
  for (const path of ["/", "/people/reactionowner", "/titles/movie/987654"]) {
    await reader.goto(path);
    await expect(
      entry.getByText("Comment removed", { exact: true }),
    ).toBeVisible();
    await expect(reactions).toHaveCount(0);
    const survivingReply = entry.locator(`[data-comment-id="${reply}"]`);
    await expect(
      survivingReply.getByRole("button", { name: "Love: 1", exact: true }),
    ).toBeVisible();
  }
  const survivingReactions = entry
    .locator(`[data-comment-id="${reply}"]`)
    .getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    });
  await survivingReactions
    .getByRole("button", { name: "React", exact: true })
    .click();
  await survivingReactions
    .getByRole("button", { name: "Care", exact: true })
    .click();
  await expect(
    survivingReactions.getByRole("button", { name: "Care: 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    (
      await reader.request.post("/api/screenr/reaction", {
        headers: { Origin: browserConfig.baseURL },
        data: { item: standalone, kind: "like" },
      })
    ).status(),
  ).toBe(404);
  const hidden = await post("title-comment", {
    title: "movie:987654",
    body: "Spoiler discussion",
    spoiler: true,
  });
  const hiddenReply = await post("comment", {
    conversation: hidden,
    body: "Spoiler reply",
    spoiler: true,
  });
  await reader.goto("/titles/movie/987654");
  const spoilerEntry = reader.locator(`[data-item-id="${hidden}"]`);
  await expect(
    spoilerEntry.getByRole("group", { name: /Reactions/ }),
  ).toHaveCount(0);
  await spoilerEntry
    .getByRole("button", {
      name: "Contains spoilers · Reveal discussion",
      exact: true,
    })
    .click();
  await expect(
    spoilerEntry.getByRole("group", {
      name: "Reactions to entry",
      exact: true,
    }),
  ).toBeVisible();
  const spoilerReply = spoilerEntry.locator(
    `[data-comment-id="${hiddenReply}"]`,
  );
  await expect(
    spoilerReply.getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toHaveCount(0);
  await spoilerReply
    .getByRole("button", {
      name: "Contains spoilers · Reveal comment",
      exact: true,
    })
    .click();
  await expect(
    spoilerReply.getByRole("group", {
      name: "Reactions to reply",
      exact: true,
    }),
  ).toBeVisible();
  const data = { item: recommended, kind: "like" };
  const headers = { Origin: browserConfig.baseURL };
  await reader.goto("/people/reactionowner");
  await reader.getByRole("button", { name: "Unfriend", exact: true }).click();
  await expect(
    reader.locator(`[data-item-id="${recommended}"]`),
  ).not.toBeVisible();
  expect(
    (
      await reader.request.post("/api/screenr/reaction", { headers, data })
    ).status(),
  ).toBe(404);
  await expect(
    owner
      .locator(`[data-item-id="${recommended}"]`)
      .getByRole("button", { name: "Love: 1", exact: true }),
  ).toHaveCount(0);
  await reader.context().close();
  await owner.context().close();
});
