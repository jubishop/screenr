import { expect, type Locator } from "@playwright/test";

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
