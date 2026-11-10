import { blockedWords } from "./blocked-words";

// Whether text holds an entry from the blocked-word list
// (docs/data-and-access.md#blocked-words). Matching ignores case, accents,
// and hidden characters such as zero-width spaces, reads common look-alikes
// as the letters they stand for, such as "@" or "4" for "a", and accepts a
// plural ending. It matches whole words only, so an ordinary word that
// contains a blocked word, such as "snigger", passes; digits around a word,
// as in a username such as "name99", don't join it. A phrase also matches
// with hyphens between its words, or none.
export function hasBlockedWord(text: string): boolean {
  const tokens = [...fold(text).matchAll(word)].map(([token]) => token);
  const readings = tokens.map(readingsOf);
  for (let start = 0; start < tokens.length; start++) {
    if (readings[start].some((reading) => listed(words, reading))) return true;
    for (const map of lookAlikes) {
      let phrase = read(trim(tokens[start]), map);
      for (
        let end = start + 1;
        end < tokens.length && end - start < longestPhrase;
        end++
      ) {
        phrase += ` ${read(trim(tokens[end]), map)}`;
        if (listed(phrases, phrase)) return true;
      }
    }
  }
  return false;
}

// Characters that stand in for letters. "1" and "|" can be "i" or "l", so a
// word is read both ways.
const lookAlikes = [
  { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" },
  { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" },
].map((digits, reading) => ({
  ...digits,
  "@": "a",
  $: "s",
  "!": "i",
  "|": reading ? "i" : "l",
})) as Record<string, string>[];
// A word's letters and digits, with any look-alike symbols in or around it.
const word = /[\p{L}\p{N}@$!|]+/gu;

// Lowercase, without accents or hidden format characters, and with
// compatibility forms such as full-width letters made plain.
function fold(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLowerCase();
}

// The ways a token can read, each way to read "1" and "|": with every
// look-alike as a letter, with the symbols around it left off as
// punctuation, as in "spic!", and with the digits around it left off too, as
// in "name99".
function readingsOf(token: string) {
  const bare = token.replace(/^[\p{N}@$!|]+|[\p{N}@$!|]+$/gu, "");
  const readings = new Set<string>();
  for (const map of lookAlikes)
    for (const form of [trim(token), token, bare])
      if (form) readings.add(read(form, map));
  return [...readings];
}

// The token without the look-alike symbols around it.
function trim(token: string) {
  return token.replace(/^[@$!|]+|[@$!|]+$/g, "");
}

function read(form: string, map: Record<string, string>) {
  return [...form].map((c) => map[c] ?? c).join("");
}

// Whether `reading` or its singular is in `set`. An "es" ending counts only
// after the letters that take it, so "spices" isn't read as "spic" + "es".
function listed(set: Set<string>, reading: string) {
  if (set.has(reading)) return true;
  if (reading.endsWith("ies") && set.has(`${reading.slice(0, -3)}y`))
    return true;
  if (/(s|z|x|ch|sh)es$/.test(reading) && set.has(reading.slice(0, -2)))
    return true;
  return reading.endsWith("s") && set.has(reading.slice(0, -1));
}

// Single words, with each phrase also written as one word, such as
// "porchmonkey", and the phrases themselves, each word read as text is.
const words = new Set<string>();
const phrases = new Set<string>();
let longestPhrase = 1;
for (const entry of blockedWords) {
  const parts = [...fold(entry).matchAll(word)].map(([part]) => part);
  words.add(parts.join(""));
  if (parts.length > 1) {
    phrases.add(parts.join(" "));
    longestPhrase = Math.max(longestPhrase, parts.length);
  }
}
