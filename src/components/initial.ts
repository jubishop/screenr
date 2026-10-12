const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function initial(text: string) {
  return graphemes.segment(text).containing(0)?.segment ?? "";
}
