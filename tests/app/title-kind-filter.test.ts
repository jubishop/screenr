import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { TitleKindButtons } =
  await import("../../src/components/title-kind-filter");

// The All, Movies, and TV filter that Friends recommend, Watch together, and
// Want to watch share, as the server renders it before the page is
// interactive.
test("the title kind filter is a labeled group whose buttons wait for the page to be interactive", () => {
  const markup = renderToStaticMarkup(
    createElement(TitleKindButtons, { value: "movie", onChange: () => {} }),
  );
  assert.match(markup, /^<div [^>]*role="group" aria-label="Title type">/);
  assert.deepEqual(
    [...markup.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map(
      ([, attributes, label]) => ({
        label,
        pressed: /aria-pressed="true"/.test(attributes),
        disabled: /\bdisabled=""/.test(attributes),
      }),
    ),
    [
      { label: "All", pressed: false, disabled: true },
      { label: "Movies", pressed: true, disabled: true },
      { label: "TV", pressed: false, disabled: true },
    ],
  );
});
