---
status: current
---

# Native iPhone app

Screenr will have a native iPhone app written in Swift and SwiftUI. It
targets iOS 27 only and uses that release's APIs freely; it does not support
earlier iOS versions. It keeps third-party dependencies to a minimum.
[PodHaven](https://github.com/jubishop/podhaven) is the model for its
architecture and guidance where they fit.

This page records the accepted decisions from the planning interview on
2026-10-13. [Issue #206](https://github.com/jubishop/screenr/issues/206) tracks
the implementation through its phase sub-issues.

## Starting constraints — 2026-10-13

The user set these constraints when they proposed the app:

- **Language and UI:** native, modern Swift with SwiftUI. Target iOS 27
  only, with no backward compatibility.
- **Dependencies:** limit third-party dependencies where reasonable and
  build features in house.
- **Push notifications:** Screenr's notifications become real push
  notifications on the iPhone.
- **Top 10:** drag reordering of the top 10, which the web app offers only
  on desktop, works natively on the phone.
- **Error reporting and logs:** set up Sentry plus logging and telemetry.
- **Model app:** mirror PodHaven's design and guidance where they fit.
- **No Xcode:** no SwiftUI preview code, and no need to open Xcode.
  Development uses the Simulator from the command line, and builds go to
  TestFlight through command-line tooling.

PodHaven requires `#Preview` coverage for every UI change. Screenr's app
diverges from it on purpose.

## Accepted decisions

### Full parity, including signup — 2026-10-13

**Decision:** The app covers every member feature of the web app:

- The four tabs: Your circle, Find a title, Friends, and Account.
- Title pages, with discussion.
- Notifications.
- Invitations.
- Profile photos.
- Settings.
- The top 10.

It also handles joining. An invitation link opens the app when it is
installed, and a new member completes sign-in and first-time setup inside
the app.

**Why:** The user chose this over keeping signup on the web. They did not
give a further reason. Bringing friend groups in through invitation links is
central to Screenr ([launch platform](product-brief.md#launch-platform--2026-09-04)).

**Rejected alternatives:**

- Native member features, with signup kept on the web.
- A read-mostly first version that sends some actions to the web.

**Consequence:** The server must accept an invitation token through the
API, not only through the `screenr-invite` browser cookie
([invitation tokens](data-and-access.md#invitation-tokens)). Invitation links
must also open the app as universal links.

### Monorepo under `ios/` — 2026-10-13

**Decision:** The app lives in this repository under `ios/`. Its issues go in
`jubishop/screenr`, alongside the web app's.

**Why:** The user accepted the recommended layout. Screenr is one product,
so this gives it:

- One place for product decisions.
- One issue tracker, which `AGENTS.md` already requires.
- Server code that agents can read while building the client.
- Server and client changes that can share a change.

The repository is public, so GitHub's macOS runners for iOS CI cost
nothing.

**Rejected alternative:** A separate `screenr-ios` repository like
PodHaven. It would keep Swift tooling apart from Node tooling. The cost
would be product decisions held in another repository, cross-repository
issues, and two checkouts.

**Consequences:**

- iOS CI runs as a separate job on a macOS runner, filtered by path.
- `AGENTS.md` and `bin/check` gain iOS sections.

### Email code, Sign in with Apple, and Google — 2026-10-13

**Decision:** The app offers three sign-in methods: the email one-time code,
Sign in with Apple, and Google. They follow the same invite-only rules and
the [one-account rule](product-brief.md#one-account-across-sign-in-methods--2026-09-05)
as the web.

- **Sign in with Apple** uses the native AuthenticationServices button. The
  server verifies Apple's ID token through Better Auth's Apple provider.
- **Google** runs through `ASWebAuthenticationSession`, so the app adds no
  Google SDK.

**Why:** The user accepted the recommendation. It keeps parity with the
web's Google sign-in and adds the native one-tap option.
[App Store guideline 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)
requires Sign in with Apple, or an equivalent private option, whenever an app
offers Google sign-in. TestFlight's external beta review applies the same
guideline.

**Rejected alternatives:**

- Email code and Sign in with Apple, without Google.
- Email code only.

**Consequence:** Apple's Hide My Email gives an account a relay address.
Activity and code emails reach that address only when Screenr's sending
domain is registered with Apple's private email relay service.

### Sign in with Apple stays on iPhone — 2026-10-13

**Decision:** Only the iPhone app offers Sign in with Apple. The web app keeps
the email code and Google. A member who joined with Apple signs in on the web
with an email code sent to their account's address. When that address is a
Hide My Email relay, the code still reaches them.

**Why:** The user chose to keep Apple permanently iPhone-only. They did not
give a reason.

**Rejected alternatives:**

- Adding web Apple sign-in later.
- Launching it on both clients together.

### Bearer sessions in the Keychain — 2026-10-13

**Decision:** The server turns on Better Auth's bearer plugin.

- **Storing the token:** after sign-in, the app stores the session token in
  the Keychain.
- **Sending the token:** the app sends `Authorization: Bearer <token>` on
  every request, including profile photo fetches.
- **Origin check:** the `/api/screenr` dispatcher skips its POST `Origin`
  check for requests that carry a bearer token. A browser never adds that
  header on its own, so cross-site request forgery does not apply to them.
  Cookie requests keep the check.
- **Session lifetime:** sessions are the same Postgres rows the web uses,
  with the same 30-day lifetime and sign-out behavior.

**Why:** The user accepted the recommendation. The credential belongs in
the Keychain, and the native client should not pose as the browser.

**Rejected alternative:** A URLSession cookie jar that sends a fixed `Origin`
header. It needs no server change, but it keeps the credential in the app's
cookie storage.

### Reuse the screen and action API — 2026-10-13

**Decision:** The app calls the same [API actions](data-and-access.md#api-actions)
as the web:

- **Reading:** `GET /api/screenr/screen?path=…` returns the view model for a
  member route. `search`, `seasons`, `episodes`, and `notifications`
  provide the rest.
- **Saving:** the existing POST actions.

The app's navigation destinations correspond one-to-one with member paths.

**Why:** The user accepted the recommendation. The server keeps one
implementation of access rules and page composition. Universal links map
directly onto app destinations.

**Rejected alternatives:**

- A separate native resource API, which duplicates composition and access
  checks.
- Reusing the existing API at first and splitting off native endpoints later.

**Consequence:** Shipped app builds depend on screen payloads, so changes
driven by the web must stay compatible with them.

**Implementation note:** [Issue #225](https://github.com/jubishop/screenr/issues/225)
built ScreenrKit's client, session store, and models. The
[ScreenrKit API](../ios/README.md#screenrkit-api) section describes the
request functions, headers, ETag cache, typed errors, and the fixture API
that UI tests launch against.

### Hand-written models checked against server fixtures — 2026-10-13

**Decision:** The app's API models are hand-written Swift `Codable` types.

- **Writing fixtures:** server tests write real responses for each screen
  route and POST action into checked-in JSON fixtures under `ios/`.
- **Checking fixtures:** Swift tests decode every fixture.
- **Effect on changes:** a server change that alters a payload changes its
  fixtures in the same commit. CI fails when the app cannot decode the result.

**Why:** The user accepted the recommendation. It needs no generator or
dependency, and payload drift appears in review as a fixture diff.

**Rejected alternatives:**

- Generating Swift from the TypeScript types. TypeScript 7's native compiler
  changed the compiler API such a generator would depend on, and generic and
  `Pick` types map poorly.
- A JSON Schema source of truth that generates both TypeScript and Swift.
  It would need a large server refactor.

### Additive payloads and a minimum build — 2026-10-13

**Decision:** The server stays compatible with shipped app builds:

- **Additive changes:** payload changes are additive by default. New fields
  are optional in Swift. New enum cases decode to an `unknown` fallback
  instead of failing the whole response.
- **Client header:** every app request sends
  `Screenr-Client: ios/<version>/<build>`.
- **Minimum build:** when a breaking change is unavoidable, the server raises
  a minimum supported build. It answers older builds with HTTP 426. The app
  then shows a required-update screen that links to TestFlight or the App
  Store.

**Why:** The user accepted the recommendation. The web deploys continuously
while app builds lag, so a breaking payload change would otherwise break
installed apps.

**Rejected alternatives:**

- Versioned API paths, which keep parallel payload shapes and access logic.
- No compatibility promise, relying on TestFlight auto-update.

### Same live-update polling as the web — 2026-10-13

**Decision:** The app follows the web's
[refresh behavior](data-and-access.md#write-lock-and-refresh-behavior):

- **Polling:** while the app is active, it polls the visible screen every
  three seconds and sends its ETag. It stops polling in the background.
- **Other refreshes:** it also refreshes when it returns to the foreground,
  when a push notification arrives, and on pull-to-refresh.
- **Incoming activity:** it shows the same "New activity" and "New replies"
  controls without moving the reader.

**Why:** The user accepted the recommendation. It needs no new server
infrastructure, and it keeps the incoming-activity behavior already accepted
for the web.

**Rejected alternatives:**

- Refreshing only on push notifications, on returning to the foreground,
  and on pull-to-refresh.
- A server-sent events stream.

### Push every notification immediately — 2026-10-13

**Decision:** Every notification the bell receives also becomes an iPhone push
notification as soon as it is created. That covers friend requests, friend
acceptances, comments on the member's entries, and replies to their comments.

- **Shared rules:** pushes use the
  [notification triggers](notifications.md#notification-triggers--2026-09-04)
  and the same access, blocking, and spoiler rules as the bell.
- **Default:** a device receives pushes once its member allows notifications
  in iOS.
- **Per-kind settings:** Account in the app lets the member turn each of the
  four kinds on or off.
- **Activity email:** it stays separate and opt-in, with its existing timing.

**Why:** The user accepted the recommendation.

**Rejected alternatives:**

- The same pushes controlled only by iOS Settings.
- A 10-minute batched summary like the activity email.

### The extension fetches push content — 2026-10-13

**Decision:** A push's APNs payload carries only the notification ID, a
generic fallback alert ("New activity on Screenr"), and `mutable-content`.

A Notification Service Extension then builds the visible alert:

1. It reads the session from the shared Keychain access group and fetches
   that notification from the API, which applies access rules at display
   time.
2. It rewrites the push as a Communication Notification. The alert shows the
   sender's avatar and name, the action (for example, "Maya replied"), and a
   short excerpt. The excerpt is hidden when the comment is marked as a
   spoiler.
3. The worker sends only notifications that are visible when it sends them.
   If one stops being visible before display, for example after blocking or
   unfriending, the extension shows the generic fallback instead of details.
   Removing the alert entirely needs Apple's notification filtering
   entitlement, which Apple grants by request.

**Why:** The user accepted the recommendation. Comment text never passes
through Apple's push service. The display respects access changes made after
the push was sent, and the sender's avatar uses native iOS presentation.

**Rejected alternatives:**

- The actor's name and an excerpt in the APNs payload.
- The actor's name only, with no extension.

**Consequence:** The API needs a single-notification read that the extension
can call. The app and the extension share a Keychain access group and an
app group.

### In-house APNs delivery from the worker — 2026-10-13

**Decision:** The existing `screenr-worker` sends pushes directly to APNs:

- **Transport:** Node's built-in `http2` module.
- **Signing:** a provider JWT (ES256), signed with Node's `crypto` module from
  an App Store Connect `.p8` key.
- **Device records:** a `push_device` table stores each device's token, APNs
  environment, and app build.
- **Registration:** a `push-device` action registers and removes devices.
  Signing out removes the device.
- **Stale tokens:** APNs status 410 deletes the token.
- **Jobs:** push jobs follow the activity email job pattern.

**Why:** The user accepted the recommendation. The protocol is small enough
to own, and it adds no runtime dependency.

**Rejected alternatives:**

- An npm APNs library.
- A hosted push service such as OneSignal or Firebase. It would add an SDK
  to the app and share device and notification data with a third party.

### Notification actions — 2026-10-13

**Decision:** Members can act on a push notification without opening the
app:

- **Friend requests:** the notification has Accept and Decline actions.
  They match the bell's inline buttons and mark the notification read in the
  same way.
- **Comments and replies:** the notification has an inline Reply text field,
  which posts a reply in that thread. The app also marks the notification
  read, since replying shows the member has seen it.
- **Tapping:** opens the notification's item and marks it read, as selecting
  it in the bell does.
- **Grouping:** notifications are grouped by conversation.

**Why:** The user accepted the recommendation.

**Rejected alternatives:**

- Accept and Decline only.
- Tapping only, with no actions.

### Unread badge kept in sync — 2026-10-13

**Decision:** The app icon badge shows the member's unread notification
count.

- **New pushes:** each push carries the current count.
- **Read elsewhere:** when read state changes anywhere, the worker sends a
  badge-only push with the new count to the member's devices. Read state
  changes when the member selects a notification, uses Mark all as read, or
  accepts or declines a friend request, on any client.

**Why:** The user accepted the recommendation, so the icon does not show a
stale count after reading on another device.

**Rejected alternatives:**

- A badge that updates only with new pushes and when the app opens.
- No badge.

### Universal links for member routes and invitations — 2026-10-13

**Decision:** `https://screenr.club/.well-known/apple-app-site-association`
claims these paths:

- Every member route: `/`, `/search`, `/titles/*`, `/people/*`, `/invites`,
  `/account`, `/watch-together`, `/conversations/*`, and item permalinks.
- Invitation links: `/join/*`.

It excludes `/api/*`, `/login`, `/setup`, `/credits`, and `/privacy`.

When the app is installed, a shared link or a group-chat invitation opens in
the app. Without the app, the link opens the web as it does today.

**Implementation:** The route handler
`src/app/.well-known/apple-app-site-association/route.ts` serves the file as
`application/json`, without the sign-in redirect that member routes use. It
lists the exclusions before the claimed paths because Apple applies the first
match. The claimed paths also include `/people`, the Friends page. Item
permalinks match as title and feed paths with query parameters.
`tests/app/universal-links.test.ts` checks the list against every member
route. The file names only the Release app,
`34TKMKM889.com.artisanalsoftware.Screenr`. Screenr Dev uses its
`screenr-dev://` scheme instead.

**Why:** The user accepted the recommendation. Invitation links that open the
app follow from [full parity](#full-parity-including-signup--2026-10-13), and
member paths map directly onto app destinations.

**Rejected alternatives:**

- Claiming only invitation and title links.
- No universal links.

### System look with Screenr colors and logo — 2026-10-13

**Decision:** The app uses the standard iOS 27 look rather than reproducing
the web's appearance.

- **Native components:** a Liquid Glass tab bar, `NavigationStack`, toolbars,
  sheets, and menus.
- **Text:** system fonts with Dynamic Type.
- **Screenr identity:** the app keeps Screenr's colors as its accent and tint,
  the app icon, and the "screenr" wordmark.

The app does not try to match the web's custom components, spacing, or Avenir
Next type.

**Why:** The user said: "i dont think we need to complicate the ios code trying
to match the website look and feel precisely. the native iphone app can have
its own look that matches the iphone ecosystem. the colors and having the
icon/logo of screenr is enough."

**Rejected alternatives:**

- Native components styled with Screenr's paper surfaces and Avenir Next.
- A faithful port of the web's look.

### A You tab instead of Account — 2026-10-13

**Decision:** The app's fourth tab is You. It shows the member's own profile,
with their top 10 and activity. Account settings sit behind a gear button in
that tab's toolbar. The other tabs are Circle, Find, and Friends. Each tab
keeps its own navigation stack.

**Why:** The user chose this over mirroring the web's Account tab, which
puts the member's own profile one tap away. They did not give a further
reason.

**Rejected alternatives:**

- Four tabs that match the web, with the profile behind an avatar button.
- Five tabs that include Notifications.

### Bell in every tab and Find as the search tab — 2026-10-13

**Decision:**

- **Bell:** the toolbar at the root of every tab shows the bell with its
  unread count. The bell opens Notifications as a sheet over the current
  screen, matching the web's in-place
  [notification panel](notifications.md#notification-panel--2026-09-11).
- **Find a title:** this is the iOS 27 search-role tab. It sits apart in the
  Liquid Glass tab bar and opens with the search field active. Suggestions
  and Friends recommend appear below the field.

**Why:** The user accepted the recommendation.

**Rejected alternatives:**

- Find as an ordinary tab with a search field at the top.
- A bell on the Circle tab only.

### Top 10 editing in a list sheet — 2026-10-13

**Decision:** On the member's own profile, an Edit button opens a sheet. The
sheet holds a vertical list of their top 10:

- **Reordering:** drag handles. Each drop sends one `top-ten` `move` with the
  new rank. If the save fails, the order rolls back and an error appears, as
  on the desktop.
- **Removing:** swipe to remove sends `remove`. This keeps the Recommend, as
  the [top 10 rules](profile-top-ten.md#top-10-entries-are-recommends--2026-10-12)
  require.

The poster row on the profile is for display only.

**Why:** The user chose the standard list over dragging posters within the
row. They did not give a reason.

**Rejected alternatives:**

- Dragging posters within the profile row.
- Offering both in-row dragging and the list.

### Sentry is the only package — 2026-10-13

**Decision:** `sentry-cocoa` is the app's only third-party Swift package.
Everything else uses the platform or small in-house code:

- **Images:** posters and profile photos use iOS 27 `AsyncImage`, which now
  supports:
  - `URLRequest` initializers, for the bearer header on `/api/photos/…`.
  - Standard HTTP caching.
  - A dedicated `URLSession` and `URLCache` through `asyncImageURLSession`.

  Add Nuke only if `AsyncImage` proves insufficient.
- **Dependency injection:** SwiftUI `Environment`, plus a small container of
  protocol-typed clients that tests replace with fakes. The app does not use
  Factory.
- **Storage:** no local database. Screens use an in-memory cache, and images
  use the HTTP cache. This matches the web's
  [no-offline-mode decision](product-brief.md#launch-platform--2026-09-04).
- **Logging:** a thin wrapper over `os.Logger` that also forwards to Sentry.
  The app does not use swift-log.

**Why:** The user said: "just Sentry and then Nuke if we feel AsyncImage isnt
enough for us." They noted iOS 27 `AsyncImage` may replace Nuke, and they plan
to investigate that for PodHaven too.

**Rejected alternatives:**

- Adding Nuke from the start.
- Copying PodHaven's dependency set: Factory, GRDB, Nuke, swift-log, Tagged,
  IdentifiedCollections, CasePaths, and others.

**Sources:** [Apple's WWDC26 SwiftUI guide](https://developer.apple.com/wwdc26/guides/swiftui/),
[AsyncImage in iOS 27](https://spaceport.build/blog/asyncimage-ios-27).

### TestFlight now, App Store later — 2026-10-13

**Decision:** Invited people get the app through TestFlight external testing
with a public link. Listing on the App Store is a later milestone.

- **Account deletion:** this is a normal issue now. App Store
  [guideline 5.1.1(v)](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage)
  requires it once the app supports signup. Its rules are in the
  [account deletion decision](product-brief.md#account-deletion--2026-10-13).
  Revoking Apple tokens means the server must exchange Apple's authorization
  code at sign-in and keep the resulting refresh token.
- **App Store milestone:** this later milestone covers a Report action under
  [guideline 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content),
  the App Store listing, the privacy nutrition label, and a reviewer demo
  account. It stays blocked until the user revisits the
  [deferred administrator moderation](product-brief.md#administrator-moderation-deferred--2026-09-04).

**Why:** The user accepted the recommendation. Members can start using the
app without reversing the moderation deferral.

**Rejected alternatives:**

- Listing on the App Store from the first milestone.
- Staying on TestFlight indefinitely. Builds expire after 90 days, and
  external testing is capped at 10,000 testers.

### App identity — 2026-10-13

**Decision:** The app's App Store identity is:

- **Bundle ID:** `com.artisanalsoftware.Screenr`.
- **Team:** Apple developer team `34TKMKM889`, which PodHaven also uses.
- **Display name:** "Screenr".
- **Shared groups:** the app and its extensions share the app group and
  Keychain access group `group.com.artisanalsoftware.Screenr`.

**Why:** The user accepted the recommendation. It uses the same developer
identity and App Store Connect setup as PodHaven.

**Rejected alternative:** A `club.screenr` prefix to match the domain.

[Running Screenr](running-screenr.md#iphone-app-accounts-and-keys) lists the
App IDs, keys, and other account records
([issue #221](https://github.com/jubishop/screenr/issues/221)).

### Dev and Release variants — 2026-10-13

**Decision:** The app has two variants.

- **Screenr Dev:**
  - Bundle ID `com.artisanalsoftware.Screenr.dev`, with a distinct icon.
  - Runs in the Simulator only.
  - Talks to a local Screenr server by default. A launch setting can point it
    at production.
  - Uses the APNs sandbox.
  - Uses a `screenr-dev://` URL scheme to stand in for universal links.
- **Screenr (Release):**
  - Talks only to `https://screenr.club`.
  - Ships through TestFlight, and later the App Store.

Tests use in-process fakes rather than a server, so they need no third
variant.

**Why:** The user accepted the recommendation.

**Rejected alternatives:**

- PodHaven's three variants, with a separate Debug app identity for tests.
- A single app identity with a hidden server switch.

### Checked-in Xcode project with synchronized folders — 2026-10-13

**Decision:** The repository commits `ios/Screenr.xcodeproj`. The project uses
synchronized folder groups (`PBXFileSystemSynchronizedRootGroup`), so new
Swift files join their target automatically. Never edit `project.pbxproj`
just to add a file.

- **Initial project file:** an agent writes it during scaffolding.
- **Later changes:** the project file changes only for new targets,
  capabilities, or build settings that cannot live in an `.xcconfig` file.
- **Build settings:** most live in checked-in `.xcconfig` files.

**Why:** The user accepted the recommendation. It follows PodHaven and needs
no third-party tool.

**Rejected alternatives:**

- XcodeGen, with a generated project that is not committed.
- Tuist manifests.

**Implementation note:** [Issue #218](https://github.com/jubishop/screenr/issues/218)
created the project, ScreenrKit, and `bin/check-ios`. The
[iPhone app guide](../ios/README.md) describes the layout, variants, checks,
and signing. The Debug configuration builds Screenr Dev, because Xcode
builds local packages without optimization only under a configuration named
Debug. Screenr Dev uses its own app group,
`group.com.artisanalsoftware.Screenr.dev`, so its data stays apart from
Screenr's in a shared Simulator. It runs only in the Simulator, so that group
needs no registration with Apple. Each app group is also the variant's
Keychain access group.

### ScreenrKit package and a thin app target — 2026-10-13

**Decision:** A local SwiftPM package, `ios/ScreenrKit`, holds:

- The API models and the API client.
- The session and Keychain storage.
- Logging and Sentry setup.
- Push content building.
- The `@Observable` view models.

The app target holds the SwiftUI views and the app lifecycle. The
Notification Service Extension imports `ScreenrKit`.

Most tests run with `swift test` on the Mac, without booting a Simulator.
Views and app wiring are tested in the Simulator.

**Why:** The user accepted the recommendation. The extension needs the same
client, models, session, and logging as the app, and fast package tests keep
the development loop short.

**Rejected alternatives:**

- One app target, with files shared into the extension through target
  membership.
- Several packages.

### Testing — 2026-10-13

**Decision:** The app is tested at three levels:

- **ScreenrKit:** Swift Testing, run with `swift test`. This includes
  decoding every server fixture.
- **UI journeys:** XCUITest in the Simulator. The app launches against an
  in-process fake API that serves the server-generated fixtures. Journeys
  cover:
  - Invitation signup.
  - Each sign-in method, up to the network boundary.
  - Sending and accepting a friend request.
  - Posting a reply.
  - The notification sheet.
  - Top 10 editing.
  - The required-update screen.
- **Server tests:** they cover what the fixtures cannot. That is bearer
  sessions, the Origin exemption, invitation tokens through the API, device
  registration, and push delivery.

**Why:** The user accepted the recommendation. The UI journeys are
deterministic and fast.

**Rejected alternatives:**

- Adding real-server signup and friendship journeys, which need Postgres and
  Next on the macOS runner.
- Skipping XCUITest, as PodHaven does.

### Swift rules adapted from PodHaven — 2026-10-13

**Decision:** `ios/AGENTS.md` adopts PodHaven's Swift rules:

- **Language mode:** Swift 6, with complete strict concurrency and strict
  memory safety.
- **Warnings:** warnings are errors. A build or test run must end with zero
  warnings.
- **Formatting:** `swift-format` runs as a build phase, with 2-space indents
  and 100-column lines.
- **Code safety:** no `try?`, no force unwraps, and no `Task.detached`.
- **Types:** model state as enums rather than Bool flags. Prefer `struct`.
- **File size:** keep each file under 1,000 lines.
- **Accessibility:** required for every UI change.
- **Tests:** red-green tests for behavior changes.

It drops the PodHaven rules that do not apply here:

- `#Preview` coverage.
- Factory.
- The vendored Lucide icon catalog. The app uses SF Symbols only.

Default actor isolation is MainActor in the app target and nonisolated in
ScreenrKit.

**Why:** The user accepted the recommendation.

**Rejected alternatives:**

- PodHaven's nonisolated default everywhere.
- Writing new rules from Apple's defaults.

### CI checks and local TestFlight releases — 2026-10-13

**Decision:**

- **CI:** a path-filtered GitHub Actions job builds and tests `ios/**` on a
  GitHub-hosted macOS runner, which is free for this public repository. It
  runs when `ios/**` or the server payload fixtures change.
- **Releases:** `bin/ios-testflight` produces TestFlight builds on the user's
  Mac. The user or an agent can run it.

The release script works in this order:

1. It requires a clean `main` whose commit passed CI.
2. It archives without the Xcode interface, using automatic signing through
   the App Store Connect API key.
3. It uploads the build.
4. It assigns the external testers group, with What to Test notes drawn from
   the commits.
5. It tags the commit `ios-v<version>b<build>`.

**Why:** The user accepted the recommendation. It follows PodHaven and keeps
signing secrets out of GitHub.

**Rejected alternatives:**

- A manually triggered CI release with cloud-managed signing.
- A TestFlight build for every push to `main` that touches `ios/`.

### In-house release tooling without fastlane — 2026-10-13

**Decision:** Releases use no fastlane and no Ruby:

- **Upload:** `xcodebuild -exportArchive` with `destination: upload` uploads
  the build.
- **Distribution:** a small Node script in the repository calls the App Store
  Connect REST API. It waits for processing, sets What to Test, and adds the
  external testers group. It signs requests with the same ES256 JWT code as
  the APNs sender.
- **Version numbers:** the marketing version lives in an `.xcconfig` file.
- **Build numbers:** each is the last `ios-v*b*` tag's build plus one.

**Why:** The user accepted the recommendation. It avoids adding Ruby and
fastlane to a Node repository.

**Rejected alternatives:**

- fastlane for distribution only, as in PodHaven.
- fastlane `gym` and `pilot` for the whole release.

### Sentry for the app and the server — 2026-10-13

**Decision:** Sentry covers both the app and the server.

- **App:** uses `sentry-cocoa`.
- **Server:** the existing `src/server/log.ts` also posts each failure to a
  separate Sentry project, as a Sentry envelope sent over HTTPS. It uses no npm
  package. The reports keep the current rule: they carry the error class, code,
  and stack frames, but never the error message.
- **Linking errors:** the app sends a request ID with every API call. An app
  error and the server failure behind it carry the same ID.

**Why:** The user accepted the recommendation. Server failures now go only to
the systemd journal, and only service failures trigger email alerts.

**Rejected alternatives:**

- Sentry for the app only.
- The `@sentry/nextjs` SDK, a large dependency against the
  [fewer-dependencies policy](foundation/engineering-policy.md).

### Pseudonymous Sentry data without content — 2026-10-13

**Decision:** Sentry runs only in Release builds, as in PodHaven. It reports:

- Crashes and errors.
- App hangs.
- MetricKit reports.
- Performance traces of app launch and API calls, for 20% of sessions.

What the app sends to Sentry:

- **Identity:** the opaque Screenr user ID only, with no name or email.
  `sendDefaultPii` is false, and Sentry does not store IP addresses.
- **Captures:** no screenshots, view hierarchy, or session replay.
- **Breadcrumbs:** URLs are reduced to route patterns, with no search queries
  or usernames.
- **Logs:** log lines and attached log tails contain no user content.

**Why:** The user accepted the recommendation. It preserves
[Screenr's privacy constraints](product-brief.md#privacy-and-the-known-people-circle--2026-09-07)
while still showing whether a crash affects one member or many, and linking
it to server failures.

**Rejected alternatives:**

- Fully anonymous reports with no user ID.
- PodHaven's defaults, which can capture names and comment text.

### App visits and client split in usage telemetry — 2026-10-13

**Decision:** The app flags its first `screen` read after launch, or after
returning to the foreground, as a visit. A visit records the
[active day](usage-telemetry.md#weekly-returns-from-active-days--2026-10-12)
the same way a web page load does. Background polls still record nothing.

Each active-day row also records which clients the member used that day: web,
iOS, or both. The owner report shows app adoption. Telemetry stays
first-party and totals-only, with 12-month retention.

**Why:** The user accepted the recommendation. Without it, a member who uses
only the app and never posts would never count as active.

**Rejected alternatives:**

- Counting app visits without recording the client.
- Recording additional app-specific events, such as push opens.

### iPhone only, in portrait — 2026-10-13

**Decision:** The app supports iPhone only, and its screens stay in portrait.
Full-screen trailer playback may rotate to landscape. On iPad the app runs in
iPhone compatibility mode.

**Why:** The user accepted the recommendation, which matches PodHaven.

**Rejected alternatives:**

- Every orientation throughout the app.
- A universal app with iPad layouts.

### Inline trailers in a SwiftUI WebView — 2026-10-13

**Decision:** A title's trailer stays collapsed behind a Play button. Tapping
Play loads the YouTube embed inline on the title page in SwiftUI's native
`WebView`, with full-screen playback available. As on the web, nothing loads
from YouTube before the member taps Play. The app adds no YouTube SDK.

**Why:** The user accepted the recommendation.

**Rejected alternative:** Opening the trailer in the YouTube app or Safari.

### Sharing and later native extras — 2026-10-13

**Decision:**

- **First build:** includes system sharing (`ShareLink`) for titles, feed
  items, and profiles. Shared links are screenr.club universal links.
- **Native extras milestone:** a later milestone, which does not block the
  first TestFlight build, covers:
  - **A share extension:** a link shared from Netflix, IMDb, TMDB, JustWatch,
    or Safari opens the matching Screenr title, where the member can Recommend
    it or mark it Want to watch.
  - **App Intents and Spotlight:** Siri and Shortcuts actions, such as "Add
    to Want to watch" and "What do my friends recommend?". Spotlight also
    indexes titles the member has interacted with.

**Why:** The user chose these two extras.

**Rejected for now:** Home Screen widgets.

### Public repository with feedback issues that link to Sentry — 2026-10-13

**Decision:** `jubishop/screenr` stays public. iOS CI runs on GitHub-hosted
macOS runners. The app follows PodHaven's feedback flow, except that its
GitHub issues never contain what members write:

1. **Feedback form:** You → Settings has a Send feedback form. It sends Sentry
   user feedback with the member's text, optional screenshots, and recent log
   tails. The log tails contain no user content.
2. **Issue workflow:** a daily GitHub Actions workflow on Linux files one issue
   per new feedback item. Each issue holds only the Sentry link, the date, and
   the app build, with no member text or screenshots. Agents read the content
   through Sentry while working the issue.

**Implementation:** `.github/workflows/sentry-feedback.yml` runs
`bin/sentry-feedback-issues` daily at 14:00 UTC, and on demand with
`gh workflow run sentry-feedback.yml`. It reads unresolved feedback from the
`screenr-ios` Sentry project with the read-only `SENTRY_AUTH_TOKEN`
repository secret, and needs only `contents: read` and `issues: write`. As
in PodHaven, it skips feedback that is resolved or that Sentry marked as
spam; Sentry flagged the #249 test feedback as spam until it was marked not
spam. It files each item as `investigation` and `area: ios`, with a hidden
`sentry-feedback:screenr-ios:<id>` marker. It skips any feedback whose marker
or link already appears in an open or closed issue. The issue copies a
Sentry value only when it matches a strict pattern for an ID or a build, so
member text cannot reach it. `tests/test_sentry_feedback_issues.py` covers
the body, deduplication, and failures. Run the script with `--dry-run` to
list what it would file.

**Why:** The user asked to match PodHaven's flow. Public issues that quoted
feedback could expose friends' names or comments. Earlier the same day the user
made the repository private for this reason. They then reversed that once the
cost became clear:

- **Free plan allowance:** the account is on GitHub Free, with 2,000 included
  private Actions minutes a month.
- **Screenr's usage:** Screenr alone used about 1,900 Actions minutes in
  September. Each push runs a 9–11 minute check job, including documentation
  pushes.
- **Hard stop:** at the default $0 spending limit, private jobs stop when the
  allowance runs out. That would block deploys.
- **PodHaven precedent:** PodHaven is public and uses Sentry. Sentry was never
  the concern, only issues that publish member text.

Data from the GitHub billing usage API on 2026-10-13.

**Rejected alternatives:**

- Filing full feedback issues in a separate private repository.
- Staying private, trimming CI minutes, and raising the spending limit.

**Supersedes:** a same-day decision that made the repository private and ran
iOS CI on a self-hosted Mac runner.

### An `area: ios` label — 2026-10-13

**Decision:** The repository has an `area: ios` label, described as "Native
iPhone app: Swift, SwiftUI, extensions, and app tooling". Issues for the app
get `area: ios`. Server, ops, and tooling work that supports the app keeps
its own area labels. An issue that spans both gets both.

**Why:** The user approved the new label, so app work can be filtered apart
from web client work.

**Rejected alternative:** Widening `area: ui` to cover both clients.

### Isolated demo circle for Apple review — 2026-10-13

**Decision:** A server command seeds a reviewer account for Apple's review,
such as `review@screenr.club`:

- **Sign-in code:** the account's email sign-in code is a fixed secret kept
  in the production environment. The server accepts it only for that one
  address, and the normal attempt and request limits still apply.
- **Demo friends:** the command also seeds two or three demo friends with
  recommendations, reviews, and a conversation. The demo accounts are friends
  only with each other, so the reviewer sees no real member's data.
- **Review notes:** the code goes in App Store Connect's review notes.
- **Reset:** reseeding resets the demo circle.

**Why:** The user accepted the recommendation. TestFlight external testing
needs Beta App Review, and Screenr's invite-only email sign-in would otherwise
leave the reviewer with no way in.

**Rejected alternatives:**

- Inviting the reviewer into the user's real circle.
- Internal TestFlight testing only, which requires every tester to be an App
  Store Connect user on the team.

[Running Screenr](running-screenr.md#demo-circle-for-apple-review) describes
the command, its environment variable, and the reset
([issue #247](https://github.com/jubishop/screenr/issues/247)).

## Open questions

None remain from the planning interview. The App Store milestone stays blocked
until the user revisits the
[deferred administrator moderation](product-brief.md#administrator-moderation-deferred--2026-09-04).
