// The application failure lines that browser specs cause on purpose. Once a
// run ends, failure-line-reporter.ts fails it on any failure line the
// application printed that no entry here expects. An entry expects a line
// printed while one of its specs ran that carries every field it names. Add
// one only for a failure a spec causes deliberately, and say why.
// docs/testing.md#failure-lines
export type ExpectedFailureLine = {
  specs: string[];
  fields: { event: string } & Record<string, string | number | boolean>;
};

export const expectedFailureLines: ExpectedFailureLine[] = [
  // tv:998021's details lack a season list, so its pickers are unavailable.
  {
    specs: ["discussion-labels.spec.ts"],
    fields: { event: "catalog response invalid", lookup: "seasons" },
  },
  // The catalog fails movie:987660's refreshed and movie:987662's viewing
  // options and movie:987663's trailer.
  {
    specs: ["title-media.spec.ts"],
    fields: { event: "catalog request failed", status: 503 },
  },
  // The catalog fails Night Signal's viewing options, which stay unknown, in
  // the first of these specs to list it; each lists the streaming fixtures.
  {
    specs: [
      "contrast.spec.ts",
      "streaming-services.spec.ts",
      "want-to-watch.spec.ts",
    ],
    fields: { event: "catalog request failed", status: 503 },
  },
];
