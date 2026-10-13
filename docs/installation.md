---
status: current
---

# Installation and offline page

This page describes how Screenr installs to a phone's home screen, how its
icons are generated, and the offline page its service worker shows.

## Home-screen installation

Screenr is installable to the home screen with no offline mode
([launch platform decision](product-brief.md#launch-platform--2026-09-04)).
`src/app/manifest.ts` serves `/manifest.webmanifest` with standalone display.
The root layout sets the iOS home-screen title, declares light and dark color
schemes, and sets one theme color per scheme: `#f7f6f0` for light and
`#0f1a17` for dark, matching each theme's page color. The manifest keeps the
light `#f7f6f0` for its theme and background colors.
Next's file conventions add head links for `src/app/favicon.ico` (16, 32, and
48 pixels), `src/app/icon.svg`, and the 180-pixel `src/app/apple-icon.png`.
The manifest lists 192- and 512-pixel icons and a 512-pixel maskable icon in
`public/icons/`. `next.config.ts` rewrites `/apple-touch-icon.png` and
`/apple-touch-icon-precomposed.png` to the Apple icon, so automatic icon
requests never reach the member route.

## App icons

`src/app/icon.svg` is the source of every icon image. After editing it, run
`npx tsx scripts/generate-icons.tsx` and commit the regenerated images. The
script renders with the resvg build bundled in Next, so it needs no system
image tools and repeats the same output. The favicon and the 192- and
512-pixel icons keep the rounded corners. The Apple and maskable icons are
opaque full squares, because iOS and Android apply their own shapes. The mark stays inside the maskable safe zone, a central circle
whose radius is 40 percent of the icon's width.

The script also renders the iPhone app's icons into
`ios/Screenr/Assets.xcassets`: a 1024-pixel full square for Screenr and a
lime one for Screenr Dev. It re-encodes them as RGB without an alpha channel,
which App Store Connect requires. `tests/app/ios-assets.test.ts` checks their
size and format, and that the app's tint and wordmark dot match the web's
brand colors. See the [iPhone app guide](../ios/README.md#icons).

## Offline page

The root layout registers `public/sw.js` on every page. The worker passes page
loads to the network with navigation preload and returns its built-in
"You’re offline" page only when a page load fails. It ignores other requests
and stores nothing in Cache Storage, so it never shows stale feeds, titles, or
member data. The page follows the device's light or dark setting with the
app's theme values for the colors it uses, which `tests/app/theme.test.ts`
keeps in step with `src/app/style.css`. The page is part of the worker
script, so browsers pick up an edited page with the changed worker at their
next update check. Browsers without service workers keep their own offline
error. The [Content-Security-Policy](deployment.md#provisioning) allows
workers only from Screenr.

## Tests

`tests/browser/installation.spec.ts` checks the head links on sign-in and
member pages and the manifest and icon responses for signed-out requests. It
also checks the theme color for each color scheme, icon sizes, opacity, and
the maskable safe zone, and that the offline page appears with the network off
while Cache Storage stays empty, in both color schemes.
Page loads in other browser tests also pass through the worker. Playwright
does not route requests that a service worker handles, so a test that
intercepts page loads should create its context with
`serviceWorkers: "block"`.
