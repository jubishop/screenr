import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// The light and dark themes: docs/interface-design.md#dark-theme-follows-the-system-setting--2026-10-12
const root = new URL("../../", import.meta.url);
const read = (path: string) =>
  readFileSync(new URL(path, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const stylesheets = [
  "src/app/style.css",
  ...readdirSync(new URL("src/app/styles/", root))
    .filter((name) => name.endsWith(".css"))
    .map((name) => `src/app/styles/${name}`),
];
const darkQuery = "@media (prefers-color-scheme: dark)";
// Brand marks and stand-ins for media keep their colors in both themes.
const shared = new Set([
  "--accent",
  "--on-accent",
  "--accent-border",
  "--brand-dot",
  "--poster-from",
  "--poster-to",
  "--poster-letter",
  "--player",
]);
const colorLiteral =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver)(?![\w-])/i;

// The light tokens are the first :root block. The dark block overrides them.
function themes(css: string) {
  const light = css.match(/^:root\s*\{([^}]*)\}/m);
  const dark = css.match(
    new RegExp(
      `^${darkQuery.replace(/[()]/g, "\\$&")}\\s*\\{\\s*:root\\s*\\{([^}]*)\\}\\s*\\}`,
      "m",
    ),
  );
  assert.ok(light && dark, "a light :root block and a dark override");
  const tokens = (block: string) =>
    new Map(
      [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(
        ([, name, value]) => [name, value.trim().toLowerCase()],
      ),
    );
  const lightTokens = tokens(light[1]);
  const darkTokens = new Map([...lightTokens, ...tokens(dark[1])]);
  return {
    light: lightTokens,
    dark: darkTokens,
    overrides: tokens(dark[1]),
    lightBlock: light[1],
    rest: css.replace(light[0], "").replace(dark[0], ""),
  };
}

const app = themes(read("src/app/style.css"));
const colorTokens = [...app.light].filter(([, value]) =>
  colorLiteral.test(value),
);

function luminance(color: string) {
  const hex = color.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("stylesheets use theme values instead of hard-coded colors", () => {
  assert.match(app.lightBlock, /color-scheme:\s*light dark;/);
  for (const path of stylesheets) {
    const css = path === "src/app/style.css" ? app.rest : read(path);
    const declarations = css
      .split(/[;{}]/)
      .map((part) => part.trim())
      .filter((part) => /^-?-?[a-z][\w-]*\s*:/i.test(part));
    for (const declaration of declarations)
      assert.doesNotMatch(declaration, colorLiteral, `${path}: ${declaration}`);
  }
});

test("every theme value used is defined, and the dark theme overrides each light color", () => {
  const defined = new Set<string>();
  const used = new Set<string>();
  for (const path of stylesheets) {
    const css = read(path);
    for (const [, name] of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(name);
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(name);
  }
  // Components set positions such as --panel-top inline.
  for (const name of readdirSync(new URL("src/components/", root)).filter(
    (file) => file.endsWith(".tsx"),
  ))
    for (const [, property] of read(`src/components/${name}`).matchAll(
      /["'](--[\w-]+)["']\s*:/g,
    ))
      defined.add(property);
  for (const name of used) assert.ok(defined.has(name), `${name} is defined`);

  for (const [name] of colorTokens)
    assert.equal(
      app.overrides.has(name),
      !shared.has(name),
      shared.has(name)
        ? `${name} is shared by both themes`
        : `${name} has a dark value`,
    );
  for (const name of app.overrides.keys())
    assert.ok(app.light.has(name), `${name} has a light value`);
});

test("theme colors meet the text and control contrast requirements in both themes", () => {
  const text = [
    ["--ink", "--paper"],
    ["--ink", "--surface"],
    ["--muted", "--paper"],
    ["--muted", "--surface"],
    ["--ink", "--pressed"],
    ["--ink", "--field-disabled"],
    ["--spoiler-ink", "--tint"],
    ["--surface", "--ink"],
    ["--surface", "--primary-hover"],
    ["--surface", "--red"],
    ["--surface", "--danger-hover"],
    ["--red", "--error-bg"],
    ["--on-accent", "--accent"],
    ...Array.from({ length: 8 }, (_, tone) => ["--ink", `--avatar-${tone}`]),
  ];
  // Controls and focus rings need 3:1 against what surrounds them.
  const controls = [
    ["--pressed-ring", "--pressed"],
    ["--muted", "--avatar-placeholder"],
  ];
  // The dark theme also keeps focus rings and field borders at 3:1. Issue
  // #196 tracks the light theme's.
  const darkControls = [
    ["--focus", "--paper"],
    ["--focus", "--surface"],
    ["--border", "--surface"],
  ];
  for (const [scheme, tokens] of [
    ["light", app.light],
    ["dark", app.dark],
  ] as const) {
    const check = (pairs: string[][], minimum: number) => {
      for (const [foreground, background] of pairs) {
        const ratio = contrast(
          tokens.get(foreground)!,
          tokens.get(background)!,
        );
        assert.ok(
          ratio >= minimum,
          `${scheme} ${foreground} on ${background}: ${ratio.toFixed(2)}`,
        );
      }
    };
    check(text, 4.5);
    check(controls, 3);
    if (scheme === "dark") check(darkControls, 3);
  }
});

test("the offline page uses the app's theme values in both themes", () => {
  const worker = readFileSync(new URL("public/sw.js", root), "utf8");
  const page = worker.match(/const offlinePage = `([\s\S]*?)`;/)![1];
  const style = page
    .match(/<style>([\s\S]*)<\/style>/)![1]
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const offline = themes(style.replace(/^ {6}/gm, ""));
  assert.match(offline.lightBlock, /color-scheme:\s*light dark;/);
  for (const [scheme, tokens] of [
    ["light", offline.light],
    ["dark", offline.dark],
  ] as const)
    for (const [name, value] of tokens)
      assert.equal(value, app[scheme].get(name), `${scheme} ${name}`);
  for (const declaration of offline.rest.split(/[;{}]/))
    assert.doesNotMatch(declaration, colorLiteral, declaration.trim());
  const themeColors = [
    ...page.matchAll(
      /<meta name="theme-color" content="([^"]+)" media="\(prefers-color-scheme: (\w+)\)" \/>/g,
    ),
  ].map(([, color, scheme]) => [scheme, color]);
  assert.deepEqual(themeColors, [
    ["light", app.light.get("--paper")],
    ["dark", app.dark.get("--paper")],
  ]);
});
