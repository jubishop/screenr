let graphemes: Intl.Segmenter | undefined;

export function initial(text: string) {
  // Browsers without Intl.Segmenter (Firefox before 125) get the first code
  // point, which still keeps an astral character or a simple emoji whole.
  if (typeof Intl.Segmenter !== "function") return Array.from(text)[0] ?? "";
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return graphemes.segment(text).containing(0)?.segment ?? "";
}
