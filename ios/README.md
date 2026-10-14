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
| `Screenr/` | The app target: the [app shell](#app-shell) in `Shell/`, feature screens in `Screens/` with their parts in a folder named for the feature, such as `Find/` and the [title page](#title-pages)'s `TitlePage/`, components several features share in `Shared/`, such as the [title list views](#title-lists), the [conversations](#conversations) that the feed, title pages, and profiles share in `Conversation/`, the app lifecycle, assets, and `Info.plist`. |
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
bin/check-ios --reuse
bin/check-ios --test-timeout <minutes>
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

The check fails fast and never hangs:

- **Diagnostics:** the test run passes `-collect-test-diagnostics never`.
  Collecting a sysdiagnose after a failed UI test took about 10 minutes and
  sometimes never finished.
- **Timeouts:** the Simulator tests stop and fail after 40 minutes, or after
  `--test-timeout <minutes>`, and the Simulator boot after 10 minutes. The
  failure shows the end of the step's log.
- **Stopping:** each step runs in its own process group. A timeout,
  Control-C, or `SIGTERM` stops that group: `SIGTERM` first, then `SIGKILL`
  for whatever is left after 5 seconds. The check then deletes its Simulator.
  Stop a check by signaling `bin/check-ios` itself, never by killing
  `xcodebuild`.

The check's inputs, the iOS files, are `ios/`, except its Markdown, and
`bin/format-swift`. A pass on a checkout whose
iOS files match `HEAD` is recorded for those exact files and the Xcode
version. With `--reuse`, the check skips itself when those files passed with
the same Xcode in the last 7 days.

There is no iOS CI. Run `bin/check-ios` before every push that changes
`ios/`. The `pre-push` hook runs it for such a push unless a recorded pass
covers the pushed files, and refuses the push when it fails; never bypass
it with `--no-verify`. See
[iOS checks before a push](../docs/development-workflow.md#ios-checks-before-a-push).
On a Mac, `bin/check --full` runs `bin/check-ios --reuse` when the iOS files
differ from where the branch left `origin/main`, including uncommitted and
untracked files. On Linux it skips the iOS checks.

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
| `APIRequest<Response>` | `API/MemberRequests.swift`, `API/AuthRequests.swift` | One static function per action, such as `.screen(path:)`, `.topTen(title:_:)`, `.signIn(email:code:)`, `.linkGoogle(idToken:nonce:)`, and `.signOut`. |
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
  token, unless a newer one replaced it. Linking a sign-in method is the
  exception: its request's `unauthorized` is `.rejectsCredential`, so a 401
  for the provider's token, such as `INVALID_TOKEN`, is
  `.rejected(status: 401)` and keeps the session. Only Better Auth's
  `UNAUTHORIZED` code ends it.
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
| `-ScreenrFixtureLog` | A file that gets a line per `/api/screenr` request, such as `GET /api/screenr/screen?path=%2F`, with ` visit` after the app's [visit](#visits) and a write's JSON body, keys sorted, after the write: `POST /api/screenr/read-notification {"id":"18"}`. An upload has its type and size instead: `POST /api/screenr/photo image/jpeg 41250 bytes`. Sent [feedback](#feedback) adds a `FEEDBACK` line. A [trailer](#trailers)'s player adds `WEB <url>` for each page it asks for. |
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
which `.screenrServices(_:)` sets as the `AsyncImage` session, with requests
from `AppServices.images`, an `ImageSource`; see [Conversations](#conversations).

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
[Settings](#settings) ends with `SignOutButton`.

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
`refreshLiveReads()` runs. Each of these, except a return, replaces a read
already in flight, which may have started before a write or the push. Each
read gives up after ten seconds. A failed read replaces the content with the
error; passing failures keep polling, and a permanent error stops it until a
read succeeds. An unchanged screen keeps its `phase`, so nothing renders
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
   tabs with `app.performShellAudit()`. It passes over what the audit cannot
   measure in a scrolling screen, as [Conversations](#conversations)
   describes. While a list row reaches beneath a bar or the keyboard, it also
   passes over contrast and clipping issues without an element, which are in
   parts of a row that VoiceOver reads with the rest of the row. `ShellTests`
   check the shell through navigation titles and `FixtureLaunch(requestLog:)`,
   so they hold when a placeholder changes; keep `DestinationView`'s
   navigation titles.

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

`ProfilePhotoModelTests` and `PhotoPreparationTests` cover choosing a photo,
and `FixturePhotoTests` check that the prepared JPEG carries none of the
original's metadata, such as its location. UI tests cannot drive the photo
picker, so against the fixture API, where `AppServices.photoLibrary` is
`.fixture`, Add and Replace photo choose `FixturePhoto.jpeg()` instead: a
deterministic 900×1200 JPEG of a gradient under heavy noise, which goes
through the same preparation and upload. The request log records the
upload's size.

## Settings

Settings is the `/account` screen in the sheet that the You tab's gear opens.
`Screenr/Screens/AccountView.swift` lists its sections, and each section is a
view in `Screens/Settings/` that takes a `SettingsContext`: the loaded
`AccountScreen`, the signed-in `Person`, `refresh()` to read the screen after
a change, and `open(_:)` for an editor sheet. Its behavior lives in
ScreenrKit's `Settings/`, `Photos/`, `Invitations/`, and `Feedback/` view
models.

| Section | View model | What it does |
| --- | --- | --- |
| Your profile | `ProfileEditorModel` | Edit profile opens a sheet that saves the display name and username together, with signup's rules and the server's messages. |
| Profile photo | `ProfilePhotoModel` | The [photo editor](#profile-photos) that setup shares. |
| Invitations | `InvitationsModel` | Invite friends pushes `/invites`: a link for 1 to 12 signups, `ShareLink` for each active link, and Revoke with a confirmation. |
| Activity emails | `ActivityEmailModel` | The switch shows the choice being saved and ignores changes until the save finishes. |
| Streaming services | `StreamingServicesModel` | A sheet with search, the selection, and Clear selections. |
| Sign-in methods | `AccountLinkModel` | Connect Google runs the sign-in flow's PKCE code flow, and Sign in with Apple uses the system button; each posts the credential to `link-social`. Against the fixture API, both use the sign-in stubs. |
| Feedback | `FeedbackModel` | Send feedback opens a sheet for a message and up to three screenshots, sent to Sentry with recent log tails; see [Feedback](#feedback). |
| Sign out | `SignOutModel` | `SignOutButton`. |

A new setting adds its section to `AccountView`'s list in one line, such as
`PushSettingsSection(settings)`, at the comment that marks its place: push
notification settings after Invitations, and Delete account last. A section that edits a draft opens its editor with
`settings.open(_:)` after adding a case to `SettingsEditor`. `AccountView`
presents those sheets outside `ScreenContent`, so a failed read, which
replaces the sections with the error, keeps an open draft.

Section headings use `SectionHeading`, and a setting's value `SettingRow`,
which keep the primary color: the system's gray falls short of the contrast
that text needs. Footers, through `SettingsFooter` or their own text, use
`.muted` for the same reason, and a destructive action on a bordered button,
such as Remove photo, uses `.danger`, since the system's red falls short of
4.5:1 on the button's gray fill.

`SettingsTests` cover the journeys: changing the name and username, uploading
and removing a photo, creating and revoking an invitation, connecting Sign in
with Apple, sending feedback, and signing out. They check what each write sent in the fixture
API's request log, since a screen read after a write still returns the
fixture. Their `performSettingsAudit()` passes over reports the iOS 27
Simulator raises for the system's list text: Dynamic Type and clipping for
headers, footers, and rows, and contrast failures for rows beneath the
navigation bar's blur or past the screen's edge, with or without an element,
using the same `glassCovers()` as `performShellAudit()`.
`testFitsTheLargestTextSize` instead reaches every control at the largest
accessibility text size. Both audits run through `performSettledAudit`: the
audit samples colors from the screen, so text still moving after a swipe can
fail contrast once, and a busy Mac can run the audit out of time. After a
failure, it audits the settled screen again and fails only when both audits
fail, so a real problem still fails.

### Feedback

Send feedback opens `FeedbackSheet`, in `Screens/Settings/FeedbackSection.swift`,
whose behavior is ScreenrKit's `FeedbackModel`, in `Feedback/`. It follows the
[feedback flow](../docs/ios-app.md#public-repository-with-feedback-issues-that-link-to-sentry--2026-10-13):

- **Form:** the member writes a message and can attach up to three images
  from the library's screenshots, through `PhotosPicker`.
  `ScreenshotPreparation` redraws each one as a JPEG at most 2048 pixels on
  its long side and under 1 MB, without the original's metadata, such as a
  location. Send needs a message. A swipe cannot close the sheet while it
  holds a draft, and once the feedback is sent the sheet thanks the member.
- **Logs:** sending attaches `LogFile.recentTails(maximumBytes:)`: up to
  256 KB of the newest complete lines of each log in the app group's log
  directory, the app's and any other process's, such as the notification
  extension's. A log that cannot be read stays behind.
- **Sentry:** `Telemetry.feedback` sends Sentry user feedback from a custom
  form, with `screenshot-1.jpg` and so on, and `app.ndjson` for each log,
  as attachments. It has no name or email; its user is the opaque user ID.
  Its `release`, `com.artisanalsoftware.Screenr@<version>+<build>`, and its
  `dist`, the build, are what the daily workflow copies into the GitHub
  issue. Sentry skips `beforeSend` for feedback, so it relies on the scope's
  user holding only that ID. Sentry queues the feedback and sends it, or
  keeps it on disk until the device is online.
- **Screenr Dev:** it never starts Sentry, so `Telemetry.feedback` is nil.
  Its form says that TestFlight builds send feedback, and Send stays off.
  Under the fixture API, feedback goes to the request log instead, as
  `FEEDBACK {"logs":["app"],"message":"…","screenshots":1}`, and Attach
  screenshots attaches `FixturePhoto`.
- **Tests:** `FeedbackTests` read the envelope that the Release options
  produce from `SentryEnvelopeCapture`'s local transport: the feedback, its
  screenshot and log tail attachments, the user ID with no name or email,
  and the release and dist. No test sends feedback to Sentry.
  `SettingsTests.testSendsFeedback` sends feedback against the fixture API.

## Conversations

The friends feed, title pages, and profiles share one interactive feed, as
the web's do ([unified title feed](../docs/title-feed.md)). Its views are in
`Screenr/Conversation/`, its behavior in ScreenrKit's `Conversation/`, and
the avatar, poster, colors, and wrapping layout it uses in `Screenr/Shared/`. The friends feed, `Screens/FeedView.swift`, shows how a
screen uses them:

```swift
// The outer view reads @Environment(\.screenrAPI) and builds the models:
//   FeedModel(api: api) { await model.refresh() }
//   ConversationStarter(subject: .title(id: id, kind: kind), api: api) { … }
// The inner view keeps them in State, outside ScreenContent, so drafts and
// the reader's place outlive a failed read.
init(model: ScreenModel, feed: FeedModel, starter: ConversationStarter) {
  self.model = model
  _feed = State(initialValue: feed)
  _starter = State(initialValue: starter)
}

ScreenContent(model: model) { screen in
  if case .title(let page) = screen.content {
    FeedList(
      feed: feed, snapshot: page.conversations, viewer: screen.user,
      target: page.target, targetUnavailable: page.targetUnavailable,
      style: .compact, headerRequests: composing
    ) {
      // The screen's own content, above the entries in the same scroll view.
      if starter.visibility == .open { StartConversationComposer(starter: starter) }
    }
  }
}
```

| Piece | Where | What it does |
| --- | --- | --- |
| `FeedList` | `Screenr/Conversation/` | The scrolling feed beneath a header: entries in visible-activity order, New activity, the permalink's scroll and highlight, "This activity is unavailable.", the empty message, and the confirmation dialog. `style: .compact` drops the poster, title, Want to watch, and Recommend for title pages. Changing `headerRequests` scrolls back to the header, such as when Start a conversation opens. |
| `EntryView`, `ThreadView`, `CommentView` | `Screenr/Conversation/` | An entry, its discussion, and one comment, following the web's `feed.tsx` and `thread.tsx`. Each entry and comment carries the accessibility identifier `entry-<id>` or `comment-<id>`. |
| `CommentComposer`, `DiscussionComposer`, `StartConversationComposer` | `Screenr/Conversation/` | The one composer form, bound to a reply or comment target, or to a `ConversationStarter` with Season and Episode pickers on a TV title. |
| `ReactionControls`, `ReactionPicker`, `FeedActionStyle`, `WriteFailure` | `Screenr/Conversation/` | Reaction counts and React, which opens the seven reactions beneath its line, as on the web (a SwiftUI `Menu` label does not follow Dynamic Type); the compact actions with 44-point hit areas; and a failed write's message beneath its control. |
| `Avatar`, `PosterImage`, `FlowLayout`, `.muted`, `.danger` | `Screenr/Shared/` | A member's photo or initial on the web's colors; a TMDB poster or the title's initial; a row that wraps; and text colors that keep 4.5:1 contrast, which the system's secondary label and red miss at small sizes. |
| `FeedModel` | ScreenrKit `Conversation/` | `@Observable` page state: accepted activity (`layout(_:viewer:)`, `receive`, `showIncoming`, and `show(entry:in:viewer:)` for a title page's friend line), revealed spoilers, each discussion's preview and groups, composers and their drafts, reactions, removals through `confirmation`, and Want to watch and Recommend with the top 10 confirmations. Every write reads the screen again through its `refresh` closure. |
| `FeedLayout`, `ThreadLayout` | ScreenrKit `Conversation/` | The web's rules as values: which entries and replies show, their order, the New activity count, the three-comment preview, Show earlier comments, and nested groups. |
| `ConversationStarter` | ScreenrKit `Conversation/` | Start a conversation: `.post` on the friends feed, or `.title(id:kind:)`, which loads a TV show's seasons and each chosen season's episodes. |
| Presentation | ScreenrKit `EntryPresentation.swift` | `item.action(style:)`, `item.title`, `discussionLabel`, `removedLabel`, `link(reply:)`, `RelativeTime`, `FinishedDate`, `ReviewStars`, `ReactionKind.options`, and `TopTenLeaving`. |
| `ImageSource` | ScreenrKit | `@Environment(\.imageSource)`: TMDB poster requests, and profile photo requests with the bearer token. Against the fixture API it loads nothing, so UI tests show placeholders. |

- **Incoming activity:** other people's new entries, moved entries, and new
  replies wait behind the shell's New activity control in all three feeds,
  as on the web, whose feeds use it for replies too. The reader's own
  entries and replies show at once, with the parents their replies need.
  Removals, withdrawn actions, and spoiler flags apply at once.
- **Writes:** after a write, `FeedModel` calls `refresh`, which reads again
  even while a poll is in flight, since that poll may have started before the
  write. Composers stay open with an empty draft after posting; Cancel keeps
  the draft.
- **Permalinks:** `FeedList` scrolls to the target entry, or to its reply
  once the reply shows, which can follow revealing a spoiler entry. The
  reply's discussion shows in full with its group open, and the target is
  tinted. A screen shows one entry on request with
  `FeedList(entryRequest: EntryRequest(entry:))`, as a title page's friend
  line does: the list calls `feed.show(entry:in:viewer:)`, which accepts
  waiting activity if the entry needs it, and scrolls to the entry.
- **Sharing:** each entry's Share uses `ShareButton` with `item.link()`: the
  title page with `?item=`, or the friends feed for a post.
- **Times:** `FeedList` keeps one minute timeline, `\.feedNow`, for every
  "2h" in the list. A time's text is hidden from VoiceOver, and the author's
  link reads the full date instead, since a label longer than its text fails
  the audit's clipping check.
- **Tests:** `ScreenrUITests/FeedQueries.swift` adds `app.entry(_:)`,
  `app.comment(_:)`, `app.composerField(_:)`, `app.scrollTo(_:)`, and
  `RequestLog.wrote(_:_:)`, which waits for a write's logged JSON body and a
  read after it. `performShellAudit()` passes over what the audit cannot
  measure in a scrolling screen: text beneath the glass bars or the
  keyboard, and Dynamic Type for scrolling content, which larger text moves
  past the screen's ends. To check large text, launch with
  `FixtureLaunch(textSize: "UICTContentSizeCategoryAccessibilityXXXL")` and
  audit there, as `FeedTests` does. Audit a composer after typing, once the
  keyboard has settled. ScreenrKit's `Support/FeedSupport.swift` has
  `FeedFixtures.entry(_:changing:)` for entries with changed fields and
  `RecordingAPI` for scripted writes.

## Find a title

Find a title, `Screenr/Screens/FindView.swift` with its parts in
`Screenr/Find/`, is the search-role tab
([decision](../docs/ios-app.md#bell-in-every-tab-and-find-as-the-search-tab--2026-10-13)).
Selecting the tab at its root activates the search field, which hides the
bar's bell until the search closes. Below the field are My services, then
search results, or Suggestions and Friends recommend, as on the
[web](../docs/interface-design.md#friends-recommend-as-a-find-a-title-tab--2026-10-12).

ScreenrKit's `FindModel` holds what the member changes, so it outlives a
failed screen read and the search keeps working:

- **Search:** typing runs the `search` action once it pauses for
  `FindTiming.typingPause` (350 ms), and the keyboard's Search key runs it at
  once. A newer search or clearing the field cancels the one in flight, and a
  late response never replaces newer results. A search gives up after ten
  seconds, as on the web. The Search key with one character asks for two;
  typing one character shows the lists again without a request.
- **Lists:** `FindList.suggestions` or `.friendsRecommend`. A `/search` link
  sets the search and list once, through `apply(_:)` and `router.findSearch`.
- **Filters:** My services keeps titles on the viewer's saved subscription
  services or free, across results and both lists, and counts the titles
  with unknown viewing options it leaves out. Friends recommend adds Movies/TV
  and Show finished; finished titles start hidden. Edit services opens
  Settings over the tab.
- **Want to watch:** Friends recommend's one-tap save sends `activity` with
  the `friends_recommend` surface, then reads the screen again. Another
  status, or the viewer's own Recommend, opens the title instead.
- **Wording:** `FindWording`, `TitleSuggestion.reasons`,
  `FriendsRecommendation.recommendedByText`, and `.action` word everything
  as the web does.

`FindSearchTests`, `FindWantToWatchTests`, and `FindListsTests` cover the
model with `FindAPI`, a fake that answers searches by their text, and
`TestClock`. `FindTests` drives the tab: searching, opening a result,
Friends recommend, and every `screen/search` and `actions/search` fixture.
`screen/search/viewer-statuses` shows Cam's own statuses, free options,
unknown availability, and no saved services.

The audit flags some standard list parts, so Find avoids them: section
headers and footers, subtitles, and secondary text are too faint at their
sizes, so de-emphasized text uses `.muted`; a label's symbol column clips
its text at large sizes; and `ContentUnavailableView` in a list row does not
grow with Dynamic Type. `ListHeader`, `SymbolText`, and `EmptyListMessage`
in `Screenr/Find/` stand in for them.

Suggestions and Friends recommend open title pages at `suggestion.destination`
and `recommendation.destination`, so the title page's Want to watch reports
the web's `suggestion`, `suggestion_recommendation`, or `friends_recommend`
surface. Search results open `Destination.title(id:)`, which reports `title`.

### Title lists

Views that list titles share these pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| `TitleRow` | `Screenr/Shared/Titles/` | A title's `PosterImage`, name, kind and year, and where it streams, with optional lines after them. As on the web at phone widths, it leaves out the overview. Put it in a `NavigationLink`. |
| `ViewingLinesView` | `Screenr/Shared/Titles/` | "On Netflix, Hulu" and "Free on Tubi TV", with saved services marked, or why there are no options. |
| `Title.kindAndYear` | ScreenrKit `Titles/` | "Movie · 2024", or only the kind without a release date. |
| `TitleViewing.matchingServices(_:)`, `access(for:)`, `lines(savedServices:)` | ScreenrKit `Titles/` | The viewer's saved services that offer a title, whether the viewer can watch it, and the lines `ViewingLinesView` shows. |
| `ScreenrAPI.send(_:within:clock:)` | ScreenrKit `API/Deadline.swift` | Sends a request that fails as `.timedOut` after a deadline. |

## Title pages

A title page, `Screenr/Screens/TitleView.swift` with its parts in
`Screenr/TitlePage/`, follows the web's
[title page](../docs/interface-design.md#compact-entries-on-title-pages--2026-10-12):
the header, Where to watch, the trailer, and "Around this title" with Start a
conversation, above the [compact feed](#conversations). Its behavior is in
ScreenrKit's `TitlePage/`:

| Piece | Where | What it does |
| --- | --- | --- |
| `TitleHeader` | ScreenrKit | The viewer's place, read from the page: Recommend, the title's rank in their top 10, the status and last-finished date, and the review, with the header's labels, the status choices, and `topTenLimit`. |
| `TitlePageModel` | ScreenrKit | `@Observable`: one write at a time, each followed by a read. Recommend (no surface), Add to top 10 and its removal, the status sheet's choices (Finished sends today; Want to watch sends `surface`), the finished date, the review, and the prompts: `leaving`, the confirmation before a ranked Recommend leaves the top 10, and `sheet` (`.status`, `.review`, or `.replace`). `reconcile(with:)` closes a prompt the page no longer needs. A failure shows beneath its control. |
| `ReviewEditor` | ScreenrKit | The review form's draft, which starts from the saved review each time it opens, its save and removal, and the removal's confirmation. |
| `FriendActivity.lineParts`, `lineGroups`, `sentence` | ScreenrKit | The friend line in the web's words, such as "Recommended by Ben Ortiz (#1) · Cam Rivera wants to watch", as pieces that wrap between words. On a phone, each group starts its own line in place of " · ". |
| `WatchAvailability.notice`, `emptyMessage`, `checkedLabel()` | ScreenrKit | Where to watch's messages, in the web's words. |
| `CalendarDay` | ScreenrKit | `YYYY-MM-DD` days in the reader's calendar, such as today for Finished. |
| `TitleHeaderView`, `WatchStatusSheet`, `ReviewSheet`, `TopTenReplaceSheet`, `AvailabilitySection`, `TrailerSection` | `Screenr/TitlePage/` | The views. The status button opens a sheet of choices with Last finished, since a SwiftUI `Menu` holds no date field. |

- **Surface:** `Destination.title(id:item:reply:from:)` carries the list that
  opened a title, as the web's `?from=` does; `destination.saveSurface` is
  `from`, or `title`. `TitleSuggestion.destination`,
  `FriendsRecommendation.destination`, and `SharedTitle.destination` open a
  title with the surface the web's links use: `.suggestion` or
  `.suggestionRecommendation`, `.friendsRecommend`, and `.watchTogether`. The
  screen read and the shared link leave it out.
- **Top 10:** Add to top 10 on a full list opens `TopTenReplaceSheet`, which
  lists the 10 and sends `top-ten` with `replace`. Profiles show and edit the
  top 10 themselves; `TitleHeader.topTenLimit` is the list's size.
- **Friend line:** each name is a button that shows that friend's entry
  through `FeedList`'s `entryRequest`.
- **Credits:** Where to watch links TMDB's viewing options page and credits
  JustWatch and TMDB, with TMDB's notice that it does not endorse Screenr.

### Trailers

The trailer stays collapsed behind Play trailer, with Watch on YouTube
([decision](../docs/ios-app.md#inline-trailers-in-a-swiftui-webview--2026-10-13)).
Play trailer creates a `WebPage` that loads `TrailerLinks.embed(_:)` inline,
and the title page keeps it in `TrailerPlayer`, so it stays open while the
page reads again. Nothing loads before Play trailer.

- **Navigation:** the page's navigation decider asks
  `TrailerLoading.decide(_:isMainFrame:embed:)`. The embed and frames inside
  it load, and the embed sends `TrailerLinks.referrer`, the site's origin, as
  the web's player does, since YouTube's embedded player needs a referrer.
  A link that would replace the player, such as YouTube's logo, opens outside
  the app.
- **Full screen:** `.webViewElementFullscreenBehavior(.enabled)` lets the
  player go full screen. The app delegate keeps every screen in portrait;
  while a player is on screen, `TrailerOrientation` lets other windows, such
  as full-screen video, turn to landscape. Check it on a device, since the
  Simulator's tests load no video.
- **Tests:** against the fixture API, `AppServices.trailers` is
  `TrailerLoading.recording`, which writes `WEB <url>` to the request log and
  loads nothing, so `TitleTests` checks that the embed is asked for only
  after Play trailer, without the network.

`TitleTests` also covers the watch status and finished date, Recommend and
its confirmation, the friend line, adding to a full top 10, the review, the
largest text size, and every `screen/title` fixture. The status and
replacement sheets are system lists, so their audit is
`performSettingsAudit()`, and the largest text size test reaches each of
their controls instead.
`screen/title/full-top-ten` shows Winter Garden while Alice's top 10 is full,
and `screen/title/finished-review` shows Paper Lanterns, which Alice finished,
reviewed, and ranks #2.

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
`LogFile.recentTail(maximumBytes:)` returns the newest complete lines.
Another process, such as the notification extension, writes a file of its
own name in the same directory, and `recentTails(maximumBytes:)` returns
each file's newest lines for the [feedback form](#feedback).

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
  reports, app hangs, MetricKit diagnostics, Sentry logs at warning and
  above, and user feedback from the [feedback form](#feedback). Traces cover
  app launch and API calls, for one launch in five.
- **Build:** every report names its build with the release
  `com.artisanalsoftware.Screenr@<version>+<build>`, Sentry's default form,
  set from `AppConfiguration`, and with the build as its dist.
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
