// Universal links open these paths in the iPhone app when it is installed:
// docs/ios-app.md#universal-links-for-member-routes-and-invitations--2026-10-13
// Apple applies the first matching component, so exclusions come first. Only
// the Release app is listed; Screenr Dev uses its screenr-dev:// scheme.
const excluded = ["/api/*", "/login", "/setup", "/credits"];
// Member routes, as src/member-routes.ts parses them, and invitations. Item
// permalinks are title or feed paths with query parameters, which match too.
const claimed = [
  "/",
  "/search",
  "/titles/*",
  "/people",
  "/people/*",
  "/invites",
  "/account",
  "/watch-together",
  "/conversations/*",
  "/join/*",
];

export function GET() {
  return Response.json({
    applinks: {
      details: [
        {
          appIDs: ["34TKMKM889.com.artisanalsoftware.Screenr"],
          components: [
            ...excluded.map((path) => ({ "/": path, exclude: true })),
            ...claimed.map((path) => ({ "/": path })),
          ],
        },
      ],
    },
  });
}
