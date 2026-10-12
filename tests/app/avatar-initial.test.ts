import { test } from "node:test";
import assert from "node:assert/strict";
import { initial } from "../../src/components/initial";

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
