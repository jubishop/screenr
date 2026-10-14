# Screenr iPhone app

The native iPhone app, in Swift and SwiftUI for iOS 27. The
[accepted decisions](../docs/ios-app.md) describe what it does and why;
[`AGENTS.md`](AGENTS.md) holds the coding rules. Everything here runs from the
command line, without opening Xcode.

It needs macOS 27 with Xcode 27 or later and an iOS 27 Simulator runtime
(`xcodebuild -downloadPlatform iOS` installs one). Commands below run from the
repository root.

## Layout

| Path | Contents |
| --- | --- |
| `Screenr.xcodeproj` | The Screenr app and ScreenrUITests targets, and the shared Screenr scheme. |
| `Config/` | The `.xcconfig` build settings, the app's entitlements, and the release export options. |
| `Screenr/` | The app target: the [app shell](#app-shell) in `Shell/`, feature screens in `Screens/`, components several features share in `Shared/`, the app lifecycle, assets, and `Info.plist`. |
| `ScreenrUITests/` | XCUITest UI tests. |
| `ScreenrKit/` | A local Swift package: `Sources/ScreenrKit`, `Tests/ScreenrKitTests`, and `Fixtures/`. |
| `build/` | Build output, check logs, and result bundles. Git ignores it. |

`Screenr/` and `ScreenrUITests/` are synchronized folders: a file added on
disk joins its target with no `project.pbxproj` change. The Screenr scheme
builds the app and tests both ScreenrKit and the UI tests. Xcode also lists
an automatic ScreenrKit scheme for the package.

## Variants

The Debug configuration builds Screenr Dev, and the Release configuration
builds Screenr. Xcode builds local packages without optimization only under
a configuration named Debug, so the names stay Debug and Release.

| Setting | Screenr Dev (Debug) | Screenr (Release) |
| --- | --- | --- |
| Bundle ID | `com.artisanalsoftware.Screenr.dev` | `com.artisanalsoftware.Screenr` |
| Server | `http://localhost:3000` | `https://screenr.club` |
| App group and Keychain group | `group.com.artisanalsoftware.Screenr.dev` | `group.com.artisanalsoftware.Screenr` |
| APNs | `development` | `production` |
| Links | `screenr-dev://` | Universal links for `screenr.club` |
| Icon | `DevAppIcon`, lime | `AppIcon`, deep green |

`Config/Base.xcconfig` holds the shared settings, `Dev.xcconfig` and
`Release.xcconfig` the variant values, and `Screenr.xcconfig` and
`ScreenrUITests.xcconfig` the target settings. `Config/Version.xcconfig` holds
the marketing version; local builds are build 1, and release builds take the
next number from the release tags. `Screenr/Info.plist` passes the variant,
server, and app group to the app, which reads them through ScreenrKit's
`AppConfiguration`. Xcode preprocesses that file, so Dev-only keys sit in an
`#if SCREENR_DEV` block.

## Checks

```sh
bin/check-ios
bin/check-ios --simulator <UDID>
```

`bin/check-ios` fails on any failed or skipped test and on any warning, from
the compiler, linker, or tools. It runs:

1. ScreenrKit's tests on the Mac with `swift test`.
2. A Release build for the Simulator.
3. The Screenr scheme's tests in an iPhone Simulator: ScreenrKit's tests
   again, on iOS, and the UI tests. It first boots the Simulator and waits
   with `xcrun simctl bootstatus` until the boot finishes, since a new
   Simulator's first boot can otherwise outlast a UI test's launch timeout
   on a slow Mac.

Without `--simulator`, it creates a Simulator on the newest iOS runtime and
deletes it afterward, so several checkouts can check at once. With
`--simulator`, it uses that Simulator and leaves it in place. Logs and result
bundles from the last run are in `ios/build/check/`.

On a Mac, `bin/check --full` runs `bin/check-ios` when `ios/` differs from
where the branch left `origin/main`, including uncommitted and untracked
files. On Linux it skips the iOS checks. GitHub Actions runs `bin/check-ios`
on a hosted Mac for pull requests and pushes to `main` that change iOS files;
see [iOS CI](../docs/development-workflow.md#ios-ci).

## Run one test

ScreenrKit on the Mac, by suite or by test:

```sh
swift test --package-path ios/ScreenrKit --scratch-path ios/build/ScreenrKit \
  --filter AppConfigurationTests
```

In the Simulator, name the target and suite with `-only-testing`, such as
`ScreenrKitTests/AppConfigurationTests` or `ScreenrUITests/LaunchTests`:

```sh
xcodebuild test -project ios/Screenr.xcodeproj -scheme Screenr \
  -configuration Debug -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath ios/build/DerivedData \
  -only-testing:ScreenrUITests/LaunchTests
```

## Run the Dev app

Use a Simulator of your own rather than one another checkout may have booted:

```sh
udid=$(xcrun simctl create screenr-dev "iPhone 18 Pro" \
  com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$udid"
open -a Simulator
xcodebuild build -project ios/Screenr.xcodeproj -scheme Screenr \
  -configuration Debug -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath ios/build/DerivedData
xcrun simctl install "$udid" \
  ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Screenr.app
xcrun simctl launch "$udid" com.artisanalsoftware.Screenr.dev
```

`xcrun simctl launch --console-pty` shows the app's output instead. Run
`xcrun simctl delete "$udid"` when you are done. The Dev app talks to the
local server that `npm run dev` starts on port 3000.

## Releases

`bin/ios-testflight` archives the Release app from a clean `main`, uploads it
to App Store Connect, tags the commit `ios-v<version>b<build>`, and adds the
build to the TestFlight groups with What to Test notes. See
[TestFlight releases](../docs/development-workflow.md#testflight-releases).

## Formatting

`bin/format-swift` formats every Swift file under `ios/` with the
`swift-format` in Xcode and the rules in `ios/.swift-format`.
`bin/format-swift --check` reports differences without changing files. The
app target's build phase runs it, so an unformatted file fails the build
before Swift compiles.

## ScreenrKit API

ScreenrKit's networking core serves the app and its extensions. Views and
view models depend only on the `ScreenrAPI` protocol and `SessionStore`:

```swift
@Environment(\.screenrAPI) private var api
@Environment(SessionStore.self) private var session

let screen = try await api.send(.screen(path: "/titles/tv/201"))
if case .title(let page) = screen.content { … }
try await api.send(.comment(conversation: item.id, body: text, spoiler: false))
```

| Piece | Where | What it does |
| --- | --- | --- |
| `ScreenrAPI`, `ScreenrClient` | `API/ScreenrClient.swift` | One method, `send(_:) async throws(APIError) -> Response`. The client runs off the caller's actor. |
| `APIRequest<Response>` | `API/MemberRequests.swift`, `API/AuthRequests.swift` | One static function per action, such as `.screen(path:)`, `.topTen(title:_:)`, `.signIn(email:code:)`, and `.signOut`. |
| `SessionStore` | `Session/SessionStore.swift` | `@MainActor @Observable`. Its `phase` is `.signedOut`, `.signedIn`, or `.updateRequired(minimumBuild:)`. |
| `KeychainStorage` | `Session/KeychainStorage.swift` | The token's Keychain item: `SystemKeychain(accessGroup:)`, or `InMemoryKeychain` in tests. |
| `APIError` | `API/APIError.swift` | `kind`, the server's `message`, Better Auth's `code`, and the `requestID` the request sent. `isPermanent` says whether polling should stop, and `explanation(otherwise:)` words the failure for the member. |
| `APIRequestObserver` | `API/APIRequestObserver.swift` | Sees every finished request: route pattern, request ID, status, duration, and error. The app's observer is `Telemetry`; see [Sentry](#sentry). |
| Models | `Models/` | `Screens.swift`, `Feed.swift`, `Titles.swift`, `People.swift` (members and notifications), and `Results.swift` (other actions and `ErrorBody`). |
| `AppServices` | `AppServices.swift` | The client, session, pending invitation, identity providers, image session, and visit tracker together, injected with `.screenrServices(_:)`. |

- **Headers:** every request sends `Screenr-Client: ios/<version>/<build>`
  and a new `Screenr-Request-Id`, plus `Authorization: Bearer <token>` while
  signed in. It never sends cookies or an `Origin`. The screen read that
  marks a [visit](#visits) also sends `Screenr-Visit: 1`.
- **Session:** a sign-in request stores the token from `set-auth-token` in
  the Keychain, and `.signOut` removes it, as does a successful
  `.deleteAccount`. A 401 to a request that carried a token removes that
  token, unless a newer one replaced it.
- **Caching:** each GET's response is kept in memory with its ETag. Reading
  the same path again sends `If-None-Match`, and a 304 returns the cached
  value. Signing in or out clears the cache.
- **Errors:** 401, 403, 404, 408, 426, 429, other 4xx, and 5xx each have a
  kind, as do no response, a timeout, cancellation, and an unreadable body.
  A 426 also moves `SessionStore.phase` to `.updateRequired`. A signed-in
  person who has not finished setup gets `.forbidden` with "Complete your
  profile first." from every action except `setup`, `delete-account`, and
  the photo actions.
- **Photos:** `.photo(userId:version:)` returns a profile photo's JPEG as
  `Data`, sent with the session's token like any request, since the server
  shows a photo only to signed-in people who may see it. A person's `photo`
  is the version to ask for.
- **Models:** properties use the camelCase form of the server's keys, such as
  `userId` for `user_id`. Unknown enum values decode as `.unknown`, and an
  unknown screen kind as `.unknown(kind:)`. Timestamps are `Date` in either
  fixture format; date-only values, such as `releaseDate`, stay `String`.
  Make a field the server adds later optional.
- **A new action:** add its request function and response model, then add
  both to `FixtureDecodingTests.models` and `RequestTests.shapes`. A fixture
  whose action has no model fails `swift test`.
- **Fakes:** a view model test passes any `ScreenrAPI` fake. For the client's
  own logic, `ScreenrClient` takes an `HTTPTransport`, which tests replace.

### Fixture API

`FixtureTransport` answers the client's requests from `ScreenrKit/Fixtures/`
in process, so UI tests run the real client without a server. Screenr Dev
uses it when launched with these arguments; Release builds ignore them:

| Argument | Value |
| --- | --- |
| `-ScreenrFixtures` | The fixtures directory. |
| `-ScreenrFixtureViewer` | The member whose fixtures answer first: `alice` (default), or `nora` for empty screens. |
| `-ScreenrFixtureSession` | `signedIn` (default) or `signedOut`. |
| `-ScreenrFixtureProfile` | `complete` (default), or `pending` for a viewer without a profile, such as `pat`: member actions get `errors/incomplete-profile`, as on the server, until a setup request succeeds. |
| `-ScreenrFixtureOverride` | A fixture that answers first, such as `screen/feed/empty`. Repeatable. |
| `-ScreenrFixtureFailure` | A fixture that answers every `/api/screenr` request, such as `errors/update-required`. |
| `-ScreenrFixtureLog` | A file that gets a line per `/api/screenr` request, such as `GET /api/screenr/screen?path=%2F`, with ` visit` after the app's [visit](#visits) and a write's JSON body, keys sorted, after the write: `POST /api/screenr/read-notification {"id":"18"}`. |
| `-ScreenrOpenURL` | A link the app opens at launch, as if the system delivered it, such as `screenr-dev://titles/tv/201`. |

In UI tests, `app.launch(with: FixtureLaunch(viewer: "nora"))` passes them,
with the directory found from the test's source path; `link` and
`requestLog` pass the last two. The fixture API keeps the session in memory.
A request gets the fixture with the same action and
query or body, then falls back to the screen's path or to a successful
fixture for the action. A matching ETag gets 304. Apart from setup, writes
change nothing, so later reads answer as before; a UI test checks what a
write sent in the request log.

Requesting a code and signing in with one succeed, and every invitation
link is available, unless an `auth/` override answers the route, such as
`auth/email-otp/send-verification-otp/rate-limited` or
`auth/invitation/unavailable`. Apple and Google sign-in accept only the stub
credentials described in [Sign-in](#sign-in). Photos are not served, so
avatars show initials.

## Sign-in

The signed-out screen, `Screenr/SignIn/SignInView.swift`, offers Sign in
with Apple, Google, and an email code
([decision](../docs/ios-app.md#email-code-sign-in-with-apple-and-google--2026-10-13)).
Its behavior lives in ScreenrKit's `SignIn/` folder:

| Piece | What it does |
| --- | --- |
| `SignInModel` | The screen's `@Observable` model. The email code takes two steps, and the second offers a new code. It shows the server's messages, such as the code limits, as the server words them. |
| `PendingInvitation` | The token of the invitation link a new member opened, which every sign-in request sends as `Screenr-Invitation`. See [invitations and setup](#invitations-and-setup). |
| `AppleNonce`, `AppleCredential` | Sign in with Apple's request gets the SHA-256 hex digest of a new nonce. The server gets the raw nonce, the identity token, the authorization code, and on the first sign-in the person's name. |
| `GoogleSignIn` | Google's authorization code flow with PKCE (S256) for the iOS client, without Google's SDK. A `WebAuthenticator` opens Google's page; the app's is SwiftUI's web authentication session. It redeems the code at Google's token endpoint with no client secret and returns the ID token and nonce. |
| `SignOutModel` | Signs out on the server. If the server does not confirm, the session stays and an alert says why, as on the web. |

`Config/Screenr.xcconfig` sets the
[iOS OAuth client](../docs/running-screenr.md#google) for both variants, and
`Info.plist` registers its reversed client ID as a URL scheme. Google
redirects to `com.googleusercontent.apps.<client>:/oauthredirect`.

When the session ends, by signing out or because the server ended it, the
client clears its screen cache and `SessionStore.onEnd` handlers run.
`AppServices` empties the image cache there, and error reporting clears its
user there. Posters and profile photos load through `AppServices.imageSession`,
which `.screenrServices(_:)` sets as the `AsyncImage` session.

Against the fixture API, which only Screenr Dev runs,
`IdentityProviders.authorization` is `.fixture`, so UI tests reach the
network boundary without an Apple ID or Google account:

- **Apple:** a plain "Sign in with Apple" button replaces the system one,
  since UI tests cannot drive Apple's sheet. It posts
  `FixtureIdentity.appleCredential(hashedNonce:)`, whose identity token names
  the hashed nonce. The fixture API accepts it only with the matching raw
  nonce and the stub authorization code.
- **Google:** `FixtureWebAuthenticator` stands in for Google's page. It
  redirects with the request's state and a code that names the PKCE challenge
  and nonce. The fixture API's Google token endpoint redeems that code only
  with the matching verifier and returns an ID token that names the nonce.
  Sign-in accepts the token only with that nonce.

Real Apple and Google sign-in need a device or Simulator with an Apple ID or
Google account, so they are checked on TestFlight builds.

## App shell

The shell is the structure every feature screen plugs into. It follows the
session, shows the tabs, maps links to destinations, keeps the visible
screen current, and provides the shared controls.

```text
ScreenrApp            builds AppServices and ShellModel, opens -ScreenrOpenURL
└─ AppRootView        follows SessionStore.phase, handles onOpenURL
   ├─ RequiredUpdateView        .updateRequired (a 426)
   ├─ SignInView                .signedOut (SignIn/)
   └─ signed in, by ShellModel.account
      ├─ SetupView              .needsSetup (a 403 on the feed; Screens/)
      └─ MainTabView            .ready
         ├─ Circle, Friends, You, Find a title (the search-role tab)
         │  └─ NavigationStack(path: $router[stack: tab])
         │     ├─ root DestinationView, with the bell (and You's gear)
         │     └─ pushed DestinationViews
         └─ sheets: NotificationsSheet, SettingsSheet (the /account screen)
```

The account check reads the friends feed once after sign-in. A 403, which the
server sends every member without a profile, shows setup; otherwise the
feed's `user` is the viewer, whose opaque user ID the app gives error
reporting, and whose username makes the You tab. When the session ends,
`SessionStore.onEnd` resets the shell, so the next member starts at Circle.
The Settings placeholder holds `SignOutButton` until Settings is built.

| Piece | Where | What it does |
| --- | --- | --- |
| `Destination` | ScreenrKit `Navigation/` | One case per member route, plus `join` and `notFound`. `Destination(path:)` and `path` match the web's member routes, `Destination(url:)` reads universal links and `screenr-dev://` links, `shareURL` builds a screenr.club link, and `pageName(for:)` names the page. |
| `Router` | ScreenrKit `Navigation/` | `@Observable`: the selected tab, each tab's stack, and the sheet. `open(_:)` takes links from outside the app, and puts an invitation link's token in `PendingInvitation`. |
| `ShellModel` | ScreenrKit `Shell/` | `@Observable`: the account check, the viewer, the bell's unread count, the app's activity, `screenModel(for:)`, `pushArrived()`, and `refreshLiveReads()`. Views read it with `@Environment(ShellModel.self)`. |
| `LiveRead`, `ScreenModel` | ScreenrKit `Shell/` | A GET request's `phase` (`loading`, `loaded`, or `failed`) and its polling. `ScreenModel` is `LiveRead<Screen>`; other live reads, such as the notifications sheet's, use `LiveRead(.notifications(), api:)`. |
| `IncomingActivity` | ScreenrKit `Shell/` | Which activity the reader accepted; the rest waits behind a control. |
| `DestinationView` | `Screenr/Shell/` | Maps each destination to its screen, owns its `ScreenModel`, and adds polling, the navigation title, and redirects. |
| `ScreenContent`, `MessageView` | `Screenr/Shell/` | Render a model's phase: a spinner, the error with Try again, or the loaded screen; and a full-screen message. |
| `.livePolling(_:)` | `Screenr/Shell/` | Connects any `LiveRead` to its view's visibility, the app's activity, pull-to-refresh, and pushes. |
| `IncomingActivityButton` | `Screenr/Shell/` | The "New activity" and "New replies" controls; `.incomingActivity(_:count:show:)` floats one over a screen. |
| `ShareButton` | `Screenr/Shell/` | A `ShareLink` for a destination's screenr.club link. |
| Feature screens | `Screenr/Screens/` | One file per screen. Each starts as a `PlaceholderScreen` that shows what the screen holds and its path. |

### Links

`Router.open(_:)` places a destination the way the web's pages relate:

| Destination | Opens |
| --- | --- |
| `/` | Circle's root. |
| `/?item=&reply=` | The feed at that entry, pushed on Circle. |
| `/search` | Find a title's root, which shows the link's search and tab from `router.findSearch`. |
| `/people` | Friends' root. |
| `/people/<viewer>` | You's root. |
| `/invites`, `/watch-together` | Pushed on Friends. |
| `/account` | Settings over You. |
| `/titles/…`, `/people/<other>`, `/conversations/…`, unknown paths | Pushed on the current tab. A conversation shows the entry it redirects to in its place. |
| `/join/<token>` | Keeps the token in `PendingInvitation` for sign-in and setup, and checks it with the server. A member who has a profile lands in Circle, as on the web, and the app forgets the token. |

Tab roots never change destination; a link adds to a stack or, for Find,
sets `router.findSearch`. SwiftUI did not report a root as appearing when its
identity changed as its tab was selected, so it never polled. Replacing a
stack's top in place reused the old screen's model, so each `DestinationView`
is identified by its destination, and a redirect renders in place.

Release builds receive universal links for `https://screenr.club`, and Screenr
Dev receives `screenr-dev://` links, whose first path segment is the URL's
host: `screenr-dev://titles/tv/201?item=<entry>`. To open one in a running
Simulator, run `xcrun simctl openurl <udid> 'screenr-dev://people/ben'` and
confirm the prompt. In UI tests, launch with `FixtureLaunch(link:)`, or call
`XCUIDevice.shared.system.open(url)` to deliver a link to the running app;
`XCUIApplication.open(_:)` relaunches it.

### Polling

`LiveRead` follows the web's
[refresh behavior](../docs/data-and-access.md#write-lock-and-refresh-behavior).
While its screen is visible and the app's scene is active, it reads when the
screen appears and every three seconds after, sending the cached ETag. It
stops in the background or when the screen disappears, and reads again when
either returns, on pull-to-refresh, and when `ShellModel.pushArrived()` or
`refreshLiveReads()` runs.
Each read gives up after ten seconds. A failed read replaces the content with
the error; passing failures keep polling, and a permanent error stops it until
a read succeeds. An unchanged screen keeps its `phase`, so nothing renders
again. `ScreenModelTests` cover the timing with a `TestClock`.

### Visits

Polls never count as activity, so the app marks its visits for
[usage telemetry](../docs/usage-telemetry.md#active-days)
([decision](../docs/ios-app.md#app-visits-and-client-split-in-usage-telemetry--2026-10-13)).
`VisitTracker` in ScreenrKit's `API/` folder gives the first `screen` read
after launch, and the first after each return from the background,
`Screenr-Visit: 1`; the server records the member's day for it, as for a
page load on the website. `AppRootView` reports each scene phase to
`AppServices.visits` before the screens read again. A pause that keeps the
app in the foreground, such as Control Center, is not a return. Only one
read carries the visit at a time, and a visit that gets no successful
answer, such as offline or the 403 before setup, moves to the next screen
read. `.screen(path:)` asks for the visit with `visit: .whenDue`; no other
request does, and a client built without a tracker, such as an extension's,
sends none. `VisitTests` cover the rules, and the fixture API's request log
marks the visit for `ShellTests`.

### Add a feature screen

1. **View:** replace the placeholder body in the destination's file under
   `Screenr/Screens/`, such as `TitleView.swift`. It receives `model` and
   `destination`. Render through `ScreenContent(model: model) { screen in … }`
   and match `screen.content`, such as `.title(let page)`. `DestinationView`
   already sets the navigation title, polling, pull-to-refresh (for a `List`
   or `ScrollView`), and redirects.
2. **Behavior:** put it in an `@Observable` view model in ScreenrKit that takes
   `any ScreenrAPI` (from `@Environment(\.screenrAPI)`). After a write, call
   `await model.refresh()`. A failed read replaces the content, so keep drafts
   in the view model or in state outside `ScreenContent`.
3. **Navigation:** push with `NavigationLink(value: Destination.title(id:))`;
   the tab's stack shows it. Use `shell.router.open(_:)` only for links from
   outside the current screen, such as a notification.
4. **Shared controls:** share with `ShareButton(destination:subject:)`. For
   incoming activity, keep an `IncomingActivity<Key>` in the view model and
   float `.incomingActivity(.activity, count: waiting.count) { … }` over the
   screen.
5. **Tests:** test the view model with `swift test`, against `ScriptedAPI` and
   `TestClock` in `Tests/ScreenrKitTests/Support/` or against
   `FixtureTransport`. Write UI journeys with
   `app.launch(with: FixtureLaunch(link: "screenr-dev://titles/tv/201"))`,
   choosing fixtures with `viewer` and `overrides`, and audit screens in the
   tabs with `app.performShellAudit()`. `ShellTests` check the shell through
   navigation titles and `FixtureLaunch(requestLog:)`, so they hold when a
   placeholder changes; keep `DestinationView`'s navigation titles.

### Notifications sheet

The bell opens `NotificationsView` (`Screenr/Screens/`) in the shell's
`NotificationsSheet`, over whatever the tab shows, as the web's
[notification panel](../docs/notifications.md#current-implementation) opens
over the page. Its behavior is ScreenrKit's `NotificationsModel`
(`Notifications/`):

- **List:** a page of up to 30 from `notifications`, All or Unread, with
  Earlier and Latest notifications. Each view is its own `LiveRead`, which
  polls while the sheet shows and sets the bell's count from the page's
  `unread`. Opening the sheet marks nothing read.
- **Selecting:** `read-notification`, then `shell.router.open(_:)` with the
  returned path, which closes the sheet and opens the item on the current
  tab, or a feed entry on Circle.
- **Mark all as read:** `read-notifications` through the shown page's
  `through`, which an earlier page keeps, so later arrivals stay unread.
- **Friend requests:** Accept, and Decline after a confirmation, through
  `respond-friend-request`. The answered row keeps its result until the view
  changes.
- **Counts:** after each action, `shell.refreshLiveReads()` makes the screen
  beneath read again, so every screen's unread count, and the bell's, catch
  up.

One action runs at a time. A failed one shows an alert with the server's
message, and the page reads again. Closing the sheet leaves the screen
beneath and its state, such as an unsent draft, untouched.

## Invitations and setup

A person joins from an invitation link, `https://screenr.club/join/<token>`
in Screenr or `screenr-dev://join/<token>` in Screenr Dev
([decision](../docs/ios-app.md#full-parity-including-signup--2026-10-13)):

1. **The link:** `Router.open(_:)` hands the token to `PendingInvitation`,
   which keeps it in the Keychain (`SystemKeychain.invitation(accessGroup:)`)
   until setup succeeds, so it survives a relaunch. `AppRootView` then
   checks it with `GET /api/auth/invitation`, as it does a token an earlier
   launch kept, because requesting a code answers the same whether or not
   the invitation counts
   ([invitation tokens](../docs/data-and-access.md#invitation-tokens)). Its
   `status` is `checking`, `available`, `unconfirmed` when the check failed,
   such as offline, or `unavailable`, which forgets the token.
2. **Sign-in:** `SignInView` says "You’re invited" while a token waits, or
   the web's "That invitation is no longer available" notice. Every sign-in
   request sends the token.
3. **Setup:** a signed-in person without a profile gets `SetupView`, whose
   `SetupModel` starts from `setup-details`: the name the sign-in gave the
   account, and its photo. Joining sends the name, username, and token to
   `setup`, and shows the server's words for any problem. A 403 checks the
   invitation again, so one that is gone is forgotten. Once setup succeeds,
   `PendingInvitation.finish()` forgets the token and `shell.checkAccount()`
   shows Circle, where the inviter is already a friend.

A member who already has a profile and follows a link lands in Circle, and
the app forgets the token. The web's setup can also confirm an unverified
email address. Apple and Google report verified addresses, and an email code
verifies its address, so the app leaves that step out; if setup ever answers
"Verify your email before joining.", signing in again with an email code
verifies the address.

### Profile photos

Setup and Settings share the member's own photo:

| Piece | Where | What it does |
| --- | --- | --- |
| `PhotoPreparation` | ScreenrKit `Photos/` | Turns a library photo upright, crops the center square, and encodes a 512×512 JPEG under 60 KB, lowering the quality and then the size (384, then 256) as the web does. It runs off the main actor. |
| `ProfilePhotoModel` | ScreenrKit `Photos/` | `@Observable`: the photo version, its JPEG once loaded or saved, and `upload`, `useGoogle`, and `remove`, which save at once and report the web's status messages. `show(userId:version:google:)` takes the server's latest values. |
| `ProfilePhotoEditor` | `Screenr/Shared/Photo/` | The photo or initial with Add or Replace photo (`PhotosPicker`), Use my Google photo, and Remove photo. |
| `ProfilePhotoView` | `Screenr/Shared/Photo/` | A decorative circle with a member's photo over their initial. |

UI tests cannot drive the photo picker, so `ProfilePhotoModelTests` and
`PhotoPreparationTests` cover choosing a photo.

## Fixtures

Server tests write JSON fixtures into `ScreenrKit/Fixtures/`. The directory
is outside the package's targets, so tests find it from their own source
path, as `TestFixtures.directory` in `Tests/ScreenrKitTests/Support/` does.
This works under `swift test` and in the Simulator, which reads the Mac's
file system. `FixtureDecodingTests` decodes every fixture as the model its
action returns, and `RequestTests` checks that the request functions build
the recorded requests.

## Logging

ScreenrKit's `Log` wraps `os.Logger`, with a logger per category:
`Log.app`, `Log.api`, `Log.session`, `Log.push`, and `Log.telemetry`. A
feature can add its own category with `LogCategory("name")`.

```swift
Log.api.warning("Request failed", .int("status", 503), .identifier("request_id", id))
```

Log lines never hold user content. The message is a string literal, and each
field is one of these:

- **Numbers:** `.int`, `.double`, `.bool`, and `.duration`, in milliseconds.
- **Constants:** `.constant` for a string literal, and `.label` for an enum
  case.
- **Opaque IDs:** `.identifier` for a request ID or a Screenr user ID. Never
  pass a username, email address, display name, or anything a member typed.
- **Routes and errors:** `.route` for a `RoutePattern`, and `.error` for an
  error's domain and code, without its message.

Each line goes to the unified log under subsystem
`com.artisanalsoftware.Screenr`. Lines at info and above also go to the log
file, and in Release builds, lines at warning and above go to Sentry logs.

The log file, `Library/Logs/Screenr/app.ndjson` in the app group container,
holds one JSON object per line: `time`, `level`, `category`, `message`,
`launch` (an ID for each launch), and `fields`. One task writes the file in
order, so logging never waits on the disk. When the file would pass 256 KB it
becomes `app.1.ndjson`, so the log keeps at most two files.
`LogFile.recentTail(maximumBytes:)` returns the newest complete lines, which
the feedback form attaches. Another process, such as the notification
extension, writes a file of its own name in the same directory.

To read the Dev app's log in your Simulator:

```sh
container=$(xcrun simctl get_app_container "$udid" \
  com.artisanalsoftware.Screenr.dev group.com.artisanalsoftware.Screenr.dev)
cat "$container/Library/Logs/Screenr/app.ndjson"
xcrun simctl spawn "$udid" log stream \
  --predicate 'subsystem == "com.artisanalsoftware.Screenr"'
```

## Sentry

`sentry-cocoa`, the only third-party package, is a ScreenrKit dependency
pinned to one release in `ScreenrKit/Package.swift` and
`ScreenrKit/Package.resolved`. It also builds for macOS, so `swift test`
covers `Telemetry`. Release builds report to the `screenr-ios` project in
Sentry organization `artisanal-software`, under these
[privacy rules](../docs/ios-app.md#pseudonymous-sentry-data-without-content--2026-10-13):

- **Release only:** `Telemetry(configuration:)` starts Sentry only for the
  Release variant, with the project's public DSN in ScreenrKit. Screenr Dev
  never starts it, so Dev builds send nothing.
- **Reports:** crashes, errors that `telemetry.capture(_:requestID:)`
  reports, app hangs, MetricKit diagnostics, and Sentry logs at warning and
  above. Traces cover app launch and API calls, for one launch in five.
- **Off:** `sendDefaultPii`, screenshots, the view hierarchy, session replay,
  accessibility identifiers, and Sentry's URLSession, file, Core Data, view
  controller, and user interaction instrumentation.
- **Identity:** `telemetry.signIn(userID:)` makes the opaque Screenr user ID
  the Sentry user, and `telemetry.signOut()` clears it whenever the session
  ends, from `SessionStore.onEnd`. Events carry no other user data, and
  Sentry's installation ID never stands in for a signed-out user. Sentry's
  session counts still use that random ID.
- **Request IDs:** the app passes `Telemetry` to `AppServices` as the API
  client's `APIRequestObserver`. For each finished call, Telemetry logs the
  method, route pattern, `Screenr-Request-Id`, status, and duration. In
  Release builds it also adds an `http` breadcrumb and, in traced launches,
  records an `http.client` transaction named by its route, such as
  `GET /api/screenr/screen?path=/people/:username`. Both carry a `request_id`
  tag, the tag the server's failure reports use, as does an error captured
  with its request ID. A failed call logs a warning, and a cancelled one logs
  at info.
- **Scrubbing:** `SentryPrivacy` runs as Sentry's `beforeSend`,
  `beforeBreadcrumb`, `beforeSendSpan`, and `beforeSendLog`. It keeps only the
  user ID, and reduces every URL to its `RoutePattern`, such as
  `/titles/:kind/:id` or `/people/:username`, without a query or fragment.
  Breadcrumbs keep only data that names no content, so titles, view
  descriptions, and accessibility identifiers are dropped. A captured error
  keeps its domain and code, but not its description or user info.

Report errors and log only through `Telemetry` and `Log`; do not call
`SentrySDK` elsewhere.

### Symbols

The Screenr target's last build phase runs only when archiving. It calls
`bin/upload-ios-symbols`, which uploads a Release device archive's dSYMs to
`screenr-ios` with `sentry-cli`. sentry-cli reads its auth token from
`SENTRY_AUTH_TOKEN` or `~/.sentryclirc`. Without sentry-cli or a token, the
script prints a warning and skips the upload; a failed upload fails the
archive. To confirm that Sentry has an archive's symbols:

```sh
sentry-cli debug-files upload --org artisanal-software --project screenr-ios \
  path/to/Screenr.xcarchive/dSYMs
```

It reports "Nothing to upload, all files are on the server" when they are
there.

## Signing

- **Simulator:** builds sign to run locally and embed the entitlements as
  simulated entitlements, so they need no provisioning profile, Apple
  account, or registered App ID.
- **Devices and archives:** automatic signing under team `34TKMKM889`, with
  the App IDs, app group, and capabilities listed in
  [Apple Developer](../docs/running-screenr.md#apple-developer). Screenr Dev
  runs only in the Simulator, so its `.dev` app group is not registered.
- **Keychain:** the app group is also the Keychain access group. Pass it as
  `kSecAttrAccessGroup`; there is no `keychain-access-groups` entitlement. In
  the Simulator, the Dev app can store and read items in its group, and
  another group fails with `errSecMissingEntitlement`. Package tests have no
  entitlements, so ScreenrKit tests use a fake Keychain.

## Icons

`npx tsx scripts/generate-icons.tsx` renders both app icons from
`src/app/icon.svg`, with the web icons; see
[app icons](../docs/installation.md#app-icons). Each is one opaque 1024-pixel
PNG, since App Store Connect rejects an icon with an alpha channel, and iOS
applies the rounded mask. Screenr Dev swaps the deep green for the web's lime
accent.

## Toolchain notes

- **`SDKROOT`:** a macOS `SDKROOT` exported by a shell profile reaches clang
  through `xcodebuild`, which then warns while linking the ScreenrKit test
  bundle for the Simulator. `bin/check-ios` removes it; unset it for direct
  `xcodebuild test` runs.
- **App Intents notice:** the build prints "Metadata extraction skipped, no
  AppIntents.framework dependency found" for targets without App Intents. It
  is not a build warning, and `bin/check-ios` ignores it.
- **Package tests in the scheme:** the project has a folder reference to
  `ScreenrKit` as well as its package reference, so the Screenr scheme can
  run ScreenrKit's tests.
- **`Info.plist`:** Xcode runs the C preprocessor in traditional mode over
  `Screenr/Info.plist`. Use `#if` only for variant differences that build
  settings cannot express.
