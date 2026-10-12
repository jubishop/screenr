import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initial } from "../../src/components/initial";
import { Avatar, avatarTone, avatarTones } from "../../src/components/avatar";

test("avatar initials keep a leading emoji or astral character whole", () => {
  assert.equal(initial("🎬 Movie Fan"), "🎬");
  assert.equal(initial("𝔄ngela"), "𝔄");
  assert.equal(initial("Renée Movie Fan 🎬"), "R");
  assert.equal(initial(""), "");
});

test("avatar initials keep a combined first character whole", () => {
  assert.equal(initial("Émile"), "É");
  assert.equal(initial("👩‍👩‍👧 Family Night"), "👩‍👩‍👧");
  assert.equal(initial("👍🏽 Thumbs"), "👍🏽");
  assert.equal(initial("🇯🇵 Fan"), "🇯🇵");
});

test("avatar initials fall back to the first code point without Intl.Segmenter", async () => {
  const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  assert.ok(segmenter);
  Reflect.deleteProperty(Intl, "Segmenter");
  try {
    const module: typeof import("../../src/components/initial") = await import(
      new URL("../../src/components/initial.ts?no-segmenter", import.meta.url)
        .href
    );
    assert.equal(module.initial("🎬 Movie Fan"), "🎬");
    assert.equal(module.initial("𝔄ngela"), "𝔄");
    assert.equal(module.initial("Renée"), "R");
    assert.equal(module.initial(""), "");
  } finally {
    Object.defineProperty(Intl, "Segmenter", segmenter);
  }
});

const person = (user_id: string, display_name: string) =>
  renderToStaticMarkup(
    createElement(Avatar, { person: { user_id, display_name } }),
  );

test("avatar colors follow the stable user ID, not the name", () => {
  const tone = /data-tone="(\d+)"/;
  const before = person("user-1", "Maya Chen").match(tone)![1];
  assert.equal(person("user-1", "Renamed Maya").match(tone)![1], before);
  assert.equal(String(avatarTone("user-1")), before);
  const tones = new Set(
    Array.from({ length: 40 }, (_, index) => avatarTone(`member-${index}`)),
  );
  assert.ok(tones.size > 4, "IDs spread across the palette");
  for (const value of tones) assert.ok(value >= 0 && value < avatarTones);
});

test("avatars show a whole first character and stay decorative", () => {
  const markup = person("user-2", "👩‍👩‍👧 Family Night");
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, />👩‍👩‍👧</);
  assert.ok(!markup.includes("Family"));
  const placeholder = renderToStaticMarkup(
    createElement(Avatar, { person: null }),
  );
  assert.match(placeholder, /avatar-placeholder/);
  assert.match(placeholder, /aria-hidden="true"/);
  assert.doesNotMatch(placeholder, /data-tone/);
});
