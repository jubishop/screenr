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
