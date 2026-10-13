// Repository paths that scripts/package.ts copies into the release before it
// installs runtime packages and overlays Next's standalone output. The
// maintenance scripts run from these files, so
// tests/app/release-package.test.ts checks that every local module they load
// is under one of these paths.
export const releasePaths: readonly string[] = [
  "public",
  "scripts",
  "src/server",
  "src/shared.ts",
  "src/member-routes.ts",
  "db",
  "ops",
  "package.json",
  "package-lock.json",
];
