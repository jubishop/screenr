import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The iPhone app's icons and colors: docs/ios-app.md#system-look-with-screenr-colors-and-logo--2026-10-13
const root = new URL("../../", import.meta.url);
const assets = "ios/Screenr/Assets.xcassets";
const icons = {
  release: `${assets}/AppIcon.appiconset/AppIcon.png`,
  dev: `${assets}/DevAppIcon.appiconset/DevAppIcon.png`,
};

function header(path: string) {
  const png = readFileSync(new URL(path, root));
  assert.equal(png.toString("latin1", 12, 16), "IHDR", `${path} is a PNG`);
  return {
    png,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
}

test("each variant has its own opaque 1024-pixel app icon", () => {
  for (const [variant, path] of Object.entries(icons)) {
    const { width, height, bitDepth, colorType } = header(path);
    assert.deepEqual([width, height], [1024, 1024], `${variant} icon size`);
    // App Store Connect rejects an app icon that has an alpha channel.
    assert.deepEqual([bitDepth, colorType], [8, 2], `${variant} icon is RGB`);
    const catalog = JSON.parse(
      readFileSync(
        new URL(path.replace(/[^/]+$/, "Contents.json"), root),
        "utf8",
      ),
    );
    assert.deepEqual(catalog.images, [
      {
        filename: path.split("/").at(-1),
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      },
    ]);
  }
  assert.notDeepEqual(header(icons.dev).png, header(icons.release).png);
});

test("the app tint and wordmark dot use the web's brand colors", () => {
  const css = readFileSync(new URL("src/app/style.css", root), "utf8");
  const light = css.match(/^:root\s*\{([^}]*)\}/m)?.[1] ?? "";
  const token = (name: string) =>
    light.match(new RegExp(`${name}:\\s*(#[\\da-f]{6});`))?.[1];
  const colorset = (name: string) =>
    JSON.parse(
      readFileSync(
        new URL(`${assets}/${name}.colorset/Contents.json`, root),
        "utf8",
      ),
    ).colors.map(
      (entry: {
        appearances?: { value: string }[];
        color: { components: Record<string, string> };
      }) => {
        const { red, green, blue } = entry.color.components;
        const hex = [red, green, blue]
          .map((part) => part.replace(/^0x/i, "").toLowerCase())
          .join("");
        return [entry.appearances?.[0]?.value ?? "any", `#${hex}`];
      },
    );
  // Deep green on light backgrounds; the lime accent on dark ones.
  assert.deepEqual(colorset("AccentColor"), [
    ["any", token("--ink")],
    ["dark", token("--accent")],
  ]);
  assert.deepEqual(colorset("BrandDot"), [["any", token("--brand-dot")]]);
});
