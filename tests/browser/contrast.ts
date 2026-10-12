import { expect, type Locator, type Page } from "@playwright/test";

// Audit the page in its current color scheme. Every visible text with a
// letter or digit meets 4.5:1 on its painted background, and every painted
// color is one of the active theme's :root values, so no color bypasses the
// theme. Posters keep their own colors, and disabled controls are exempt.
export async function expectThemedPage(page: Page, name: string) {
  const { contrast, foreign } = await page.evaluate(() => {
    const parse = (color: string) => {
      const match = color.match(/^rgba?\(([^)]*)\)$/);
      if (!match) throw new Error(`Unsupported color: ${color}`);
      const channels = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return { rgb: channels.slice(0, 3), alpha: channels[3] ?? 1 };
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const describe = (element: Element) => {
      const classes = element.getAttribute("class")?.trim().split(/\s+/) ?? [];
      const text = element.textContent?.trim().slice(0, 40) ?? "";
      return `${[element.localName, ...classes].join(".")} "${text}"`;
    };

    const names = new Set<string>();
    const collect = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText === ":root")
          for (const property of rule.style)
            if (property.startsWith("--")) names.add(property);
        if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) collect(sheet.cssRules);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("i");
    document.body.append(probe);
    const allowed = new Set(["rgba(0, 0, 0, 0)"]);
    for (const name of names) {
      const value = root.getPropertyValue(name).trim();
      if (!CSS.supports("color", value)) continue;
      probe.style.color = value;
      allowed.add(getComputedStyle(probe).color);
    }
    probe.remove();

    const foreign = new Set<string>();
    const contrast: string[] = [];
    const elements = [document.body, ...document.body.querySelectorAll("*")];
    for (const element of elements) {
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const style = getComputedStyle(element);
      const check = (property: string, value: string) => {
        if (!allowed.has(value))
          foreign.add(`${describe(element)} ${property}: ${value}`);
      };
      check("color", style.color);
      check("background-color", style.backgroundColor);
      for (const side of ["top", "right", "bottom", "left"]) {
        const value = (part: string) =>
          style.getPropertyValue(`border-${side}-${part}`);
        if (value("style") !== "none" && parseFloat(value("width")) > 0)
          check(`border-${side}-color`, value("color"));
      }
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0)
        check("outline-color", style.outlineColor);
      for (const property of ["box-shadow", "background-image"])
        for (const color of style
          .getPropertyValue(property)
          .match(/rgba?\([^)]*\)/g) ?? [])
          check(property, color);
      if (element instanceof SVGElement)
        for (const property of ["fill", "stroke"]) {
          const value = style.getPropertyValue(property);
          if (value.startsWith("rgb")) check(property, value);
        }
      if (style.accentColor !== "auto")
        check("accent-color", style.accentColor);

      const text = [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          /[\p{L}\p{N}]/u.test(node.textContent ?? ""),
      );
      const rect = element.getBoundingClientRect();
      if (!text || rect.width <= 1 || rect.height <= 1) continue;
      let background: number[] | undefined;
      let skip = false;
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const painted = getComputedStyle(node);
        if (painted.opacity !== "1") {
          skip = true;
          if (!node.matches(':disabled, [aria-disabled="true"]'))
            contrast.push(`${describe(element)}: translucent`);
          break;
        }
        if (background) continue;
        if (painted.backgroundImage !== "none") {
          skip = true;
          if (!node.matches(".poster"))
            contrast.push(`${describe(element)}: image background`);
          break;
        }
        const fill = parse(painted.backgroundColor);
        if (fill.alpha === 0) continue;
        if (fill.alpha !== 1) {
          skip = true;
          contrast.push(`${describe(element)}: translucent background`);
          break;
        }
        background = fill.rgb;
      }
      if (skip) continue;
      if (!background) {
        contrast.push(`${describe(element)}: no painted background`);
        continue;
      }
      const foreground = parse(style.color);
      const [light, dark] = [
        luminance(foreground.rgb),
        luminance(background),
      ].sort((a, b) => b - a);
      const ratio = (light + 0.05) / (dark + 0.05);
      if (foreground.alpha !== 1 || ratio < 4.5)
        contrast.push(
          `${describe(element)}: ${style.color} on rgb(${background.join(", ")}) is ${ratio.toFixed(2)}:1`,
        );
    }
    return { contrast, foreign: [...foreign] };
  });
  expect.soft(contrast, `${name}: text below 4.5:1`).toEqual([]);
  expect.soft(foreign, `${name}: colors outside the theme`).toEqual([]);
}

// Read the text color and its painted background, including transparent wrappers.
// Fail on unsupported paint effects instead of reporting a misleading ratio.
export async function expectTextContrast(text: Locator) {
  await expect(text).toBeVisible();
  const colors = await text.evaluate((element) => {
    const rgb = (color: string) => {
      if (!/^rgba?\(/.test(color))
        throw new Error(`Unsupported color: ${color}`);
      const channels = color.match(/[\d.]+/g)!.map(Number);
      return { channels: channels.slice(0, 3), alpha: channels[3] ?? 1 };
    };
    const foreground = rgb(getComputedStyle(element).color);
    if (foreground.alpha !== 1) throw new Error("Expected opaque text");
    let background: number[] | undefined;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.opacity !== "1" ||
        style.filter !== "none" ||
        style.mixBlendMode !== "normal"
      )
        throw new Error("Unsupported text paint effect");
      if (background) continue;
      if (style.backgroundImage !== "none")
        throw new Error("Expected a solid text background");
      const painted = rgb(style.backgroundColor);
      if (painted.alpha === 0) continue;
      if (painted.alpha !== 1) throw new Error("Expected an opaque background");
      background = painted.channels;
    }
    if (!background) throw new Error("No painted background found");
    return { foreground: foreground.channels, background };
  });
  // WCAG relative luminance and contrast: do not round before the assertion.
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const foreground = luminance(colors.foreground);
  const background = luminance(colors.background);
  const ratio =
    (Math.max(foreground, background) + 0.05) /
    (Math.min(foreground, background) + 0.05);
  expect
    .soft(ratio, `${text}: ${JSON.stringify(colors)}`)
    .toBeGreaterThanOrEqual(4.5);
  return { ...colors, ratio };
}
