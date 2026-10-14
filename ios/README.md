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
| `Screenr.xcodeproj` | The Screenr app, ScreenrShare extension, and ScreenrUITests targets, and the shared Screenr scheme. |
| `Config/` | The `.xcconfig` build settings, the app's and extension's entitlements, and the release export options. |
| `Screenr/` | The app target: the [app shell](#app-shell) in `Shell/`, feature screens in `Screens/` with their parts in a folder named for the feature, such as `Find/` and the [title page](#title-pages)'s `TitlePage/`, components several features share in `Shared/`, such as the [title list views](#title-lists), the [conversations](#conversations) that the feed, title pages, and profiles share in `Conversation/`, the iOS side of [push notifications](#push-notifications) in `Push/`, the app lifecycle, assets, and `Info.plist`. |
| `ScreenrShare/` | The [share extension](#share-extension), which the app embeds: its view controller, views, and `Info.plist`. |
| `ScreenrUITests/` | XCUITest UI tests. |
| `ScreenrKit/` | A local Swift package: `Sources/ScreenrKit`, `Tests/ScreenrKitTests`, and `Fixtures/`. |
| `build/` | Build output, check logs, and result bundles. Git ignores it. |

`Screenr/`, `ScreenrShare/`, and `ScreenrUITests/` are synchronized folders:
a file added on disk joins its target with no `project.pbxproj` change. The
Screenr scheme builds the app with its extension and tests both ScreenrKit
and the UI tests. Xcode also lists
an automatic ScreenrKit scheme for the package.

## Variants

The Debug configuration builds Screenr Dev, and the Release configuration
builds Screenr. Xcode builds local packages without optimization only under
a configuration named Debug, so the names stay Debug and Release.

| Setting | Screenr Dev (Debug) | Screenr (Release) |
| --- | --- | --- |
| Bundle ID | `com.artisanalsoftware.Screenr.dev` | `com.artisanalsoftware.Screenr` |
| Share extension | `com.artisanalsoftware.Screenr.dev.Share` | `com.artisanalsoftware.Screenr.Share` |
| Server | `http://localhost:3000` | `https://screenr.club` |
| App group and Keychain group | `group.com.artisanalsoftware.Screenr.dev` | `group.com.artisanalsoftware.Screenr` |
| APNs | `development` | `production` |
| Links | `screenr-dev://` | Universal links for `screenr.club` |
| Icon | `DevAppIcon`, lime | `AppIcon`, deep green |

`Config/Base.xcconfig` holds the shared settings, `Dev.xcconfig` and
`Release.xcconfig` the variant values, and `Screenr.xcconfig`,
`ScreenrShare.xcconfig`, and `ScreenrUITests.xcconfig` the target settings.
`Config/Version.xcconfig` holds the marketing version; local builds are build
1, and release builds take the next number from the release tags, which the
extension shares. `Screenr/Info.plist` passes the variant, server, and app
group to the app, which reads them through ScreenrKit's `AppConfiguration`,
as `ScreenrShare/Info.plist` does for the extension. The app's also passes
its APNs environment, which `AppConfiguration.pushTarget(infoDictionary:)`
reads. Xcode preprocesses both files, so Dev-only keys sit in an
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
  `.deleteAccount`. `SessionStore.ending` then says how the session ended,
  `.signedOut` or `.accountDeleted`, until the next sign-in. A sign-in made
  `.confirming(userId:)` keeps its new token only when the response names
  that user; see [account deletion](#account-deletion). A 401 to a request
  that carried a token removes that token, unless a newer one replaced it. Linking a sign-in method is the
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
| `-ScreenrFixturePush` | The notification permission the app finds: `undecided` (default), `allowed`, or `denied`; or `system` for iOS's own permission and APNs registration. See [push notifications](#push-notifications). |
| `-ScreenrOpenURL` | A link the app opens at launch, as if the system delivered it, such as `screenr-dev://titles/tv/201`. |
| `-ScreenrAppearance` | `dark` or `light`, in place of the system's appearance, which a Simulator changes for its apps only after it restarts. |
| `-ScreenrPushTap` | A notification ID the app opens at launch, as if the member had tapped its push, such as `18`. |

In UI tests, `app.launch(with: FixtureLaunch(viewer: "nora"))` passes them,
with the directory found from the test's source path; `requestLog`, `link`,
`appearance`, and `pushTap` pass `-ScreenrFixtureLog`, `-ScreenrOpenURL`,
`-ScreenrAppearance`, and `-ScreenrPushTap`. The fixture API keeps the
session in memory.
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
Those controls are `SignInControls`, which
[account deletion](#account-deletion) reuses to confirm it's the member.
Their behavior lives in ScreenrKit's `SignIn/` folder:

| Piece | What it does |
| --- | --- |
| `SignInModel` | The screen's `@Observable` model. The email code takes two steps, and the second offers a new code. It shows the server's messages, such as the code limits, as the server words them. |
| `PendingInvitation` | The token of the invitation link a new member opened, which every sign-in request sends as `Screenr-Invitation`. See [invitations and setup](#invitations-and-setup). |
| `AppleNonce`, `AppleCredential` | Sign in with Apple's request gets the SHA-256 hex digest of a new nonce. The server gets the raw nonce, the identity token, the authorization code, and on the first sign-in the person's name. |
| `GoogleSignIn` | Google's authorization code flow with PKCE (S256) for the iOS client, without Google's SDK. A `WebAuthenticator` opens Google's page; the app's is SwiftUI's web authentication session. It redeems the code at Google's token endpoint with no client secret and returns the ID token and nonce. |
| `SignOutModel` | Signs out on the server. If the server does not confirm, the session stays and an alert says why, as on the web. |

`Config/Base.xcconfig` sets the
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
| `ShellModel` | ScreenrKit `Shell/` | `@Observable`: the account check, the viewer, the bell's unread count, the app's activity, `screenModel(for:)`, `pushArrived()`, `refreshLiveReads()`, and `onUnreadCount(_:)`, which reports each unread count, such as for the app icon's badge. Views read it with `@Environment(ShellModel.self)`. |
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
request does, and a client built without a tracker, such as the share
extension's from `AppServices(…, host: .shareExtension)`, sends none. `VisitTests` cover the rules, and the fixture API's request log
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
   describes. While a list row or control reaches beneath a bar or the
   keyboard or past the screen's edge, it also passes over contrast,
   clipping, and text detection issues without an element, which are in parts
   of a row that VoiceOver reads with the rest of the row or in text cut off
   at that edge, such as the next poster in a row that scrolls sideways. In a
   screen that scrolls, it passes over Dynamic Type issues without an element
   too. `ShellTests`
   check the shell through navigation titles and `FixtureLaunch(requestLog:)`,
   so they hold when a placeholder changes; keep `DestinationView`'s
   navigation titles. To check dark mode, launch with
   `FixtureLaunch(appearance: .dark)`. The audit still judges contrast in the
   Simulator's own appearance, so measure a filled button's label with
   `labelContrast()`, as `NotificationsTests` does for Accept.

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

## Push notifications

The app's side of [push delivery](../docs/notifications.md#push-delivery) and
[push devices](../docs/data-and-access.md#push-devices-and-settings). Its
behavior is ScreenrKit's `PushNotifications` (`Push/`), with iOS behind the
`PushSystem` protocol. `Screenr/Push/` holds `SystemPush`, which wraps
`UNUserNotificationCenter` and `UIApplication`, and the app's `AppDelegate`,
in `Shell/`, receives the APNs device token and the notification center's
callbacks.
`ScreenrApp` builds one `PushNotifications`, hands it to `AppDelegate.push`
before launch finishes, and puts it in the environment.

- **Permission:** the app asks for alerts, badges, and sounds only when the
  member can see why: as Circle opens for a new member who just finished
  setup, the first time a member opens the bell, and from Turn on
  notifications in [Settings](#settings). It never asks at launch or before
  sign-in. iOS shows its prompt once; after that, Settings offers Open iOS
  Settings while notifications are off.
- **Registration:** while the tabs show, each launch and each return to the
  foreground reads the permission. When notifications are allowed, the app
  asks APNs for the device token, and `AppDelegate` passes it to
  `received(token:)`, which registers it with `push-device` once per session:
  the token in lowercase hex, and the environment, topic, and build of the
  `PushTarget` that `AppConfiguration.pushTarget(infoDictionary:)` reads. A failed registration tries again on the next return. If
  the member turns notifications off in iOS Settings after this launch
  registered, the next return removes the device. Signing out ends the
  session, and the server deletes the session's devices with it; the app
  clears Notification Center and the badge, and the next member registers
  the device again.
- **Environment:** `SCREENR_APS_ENVIRONMENT` in `Dev.xcconfig` and
  `Release.xcconfig` sets both the `aps-environment` entitlement and the
  `ScreenrAPSEnvironment` Info.plist key, so a token always names the APNs
  environment that issued it: `development` (`sandbox`) for Screenr Dev,
  which runs in the Simulator, and `production` for the Release builds that
  TestFlight and the App Store install. The topic is the bundle ID. Only the
  app reads them: the share extension handles no notifications, so its
  `AppServices.push` is nil.
- **Categories:** at launch, `AppDelegate` registers
  `PushCategory.notificationCategories`: `FRIEND_REQUEST` and `COMMENT`, the
  categories the worker names, with no actions yet. Notification actions add
  their `UNNotificationAction`s in `PushCategory.notificationCategory` and
  handle their identifiers in `AppDelegate`'s
  `userNotificationCenter(_:didReceive:)`, which routes only the default
  action, a tap, today.
- **Taps:** `PushTap(userInfo:)` reads the payload's `notificationId`, and
  `open(_:)` reads that notification with `GET /api/screenr/notification`.
  It opens the notification's `href` with `shell.router.open(_:)`, as the
  bell does, then sends `read-notification` and refreshes the live screens.
  A notification the member can no longer see, a payload without an ID, or
  a failed read opens the bell instead; while signed out or with a required
  update, a tap does nothing. A tap that launches the app works the same
  way: the router keeps the destination until the tabs show.
- **While open:** a push that arrives while the app is open shows its
  banner, sound, and badge as usual, and calls `shell.pushArrived()`, so the
  visible screen reads again.
- **Badge:** `ShellModel.onUnreadCount` reports every unread count the app
  reads, and `PushNotifications` sets the app icon's badge to it with
  `setBadgeCount`, skipping repeats except for the first count after each
  return to the foreground. When the session ends, the badge goes to 0. The
  worker's [badge-only updates](../docs/notifications.md#badge-only-updates)
  keep it current while the app is closed.

### Push tests

`PushNotificationsTests` and `PushSettingsModelTests` cover the behavior with
`RecordingPushSystem` and `RecordingAPI`. Fixture launches use
`FixturePushSystem` instead of iOS, so UI tests never meet the permission
prompt: `-ScreenrFixturePush` sets the permission the app finds, a member who
has not decided allows notifications when asked, and no device token
arrives, so nothing registers. `PushTests` follow a tap with
`FixtureLaunch(pushTap: "18")`, which passes `-ScreenrPushTap`.

To see a real push in your Simulator against the fixture API, launch with
`-ScreenrFixturePush system`, which keeps iOS's permission and APNs
registration, allow notifications when the bell asks, and send a payload
shaped like the worker's with `xcrun simctl push`:

```sh
xcrun simctl launch "$udid" com.artisanalsoftware.Screenr.dev \
  -ScreenrFixtures "$PWD/ios/ScreenrKit/Fixtures" -ScreenrFixturePush system
cat > payload.apns <<'EOF'
{
  "aps": {
    "alert": { "body": "New activity on Screenr" },
    "badge": 6,
    "sound": "default",
    "mutable-content": 1,
    "category": "COMMENT",
    "thread-id": "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
  },
  "notificationId": "18"
}
EOF
xcrun simctl push "$udid" com.artisanalsoftware.Screenr.dev payload.apns
```

Tapping the notification opens Harbor Lights at Ben's reply. The fixture
request log, from `-ScreenrFixtureLog`, shows the registration and the tap's
requests.

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
| Push notifications | `PushSettingsModel`, `PushNotifications` | A switch for each kind (friend requests, acceptances, comments, replies) through `push-settings`; each shows the choice being saved and ignores changes until its save finishes. Turn on notifications shows iOS's prompt while the member has not decided, and Open iOS Settings goes to Screenr's notification settings once they turned them off. See [push notifications](#push-notifications). |
| Activity emails | `ActivityEmailModel` | The switch shows the choice being saved and ignores changes until the save finishes. |
| Streaming services | `StreamingServicesModel` | A sheet with search, the selection, and Clear selections. |
| Sign-in methods | `AccountLinkModel` | Connect Google runs the sign-in flow's PKCE code flow, and Sign in with Apple uses the system button; each posts the credential to `link-social`. Against the fixture API, both use the sign-in stubs. |
| Feedback | `FeedbackModel` | Send feedback opens a sheet for a message and up to three screenshots, sent to Sentry with recent log tails; see [Feedback](#feedback). |
| Sign out | `SignOutModel` | `SignOutButton`. |
| Delete account | `AccountDeletionModel` | A sheet that confirms it's the member with a new sign-in, then deletes the account after a confirmation; see [account deletion](#account-deletion). |

A new setting adds its section to `AccountView`'s list in one line, such as
`PushSettingsSection(settings)`; Delete account stays last. A section that
edits a draft opens its editor with
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
and removing a photo, creating and revoking an invitation, turning on
notifications and changing a push setting, connecting Sign in with Apple,
sending feedback, and signing out. They check what each write sent in the
fixture API's request log, since a screen read after a write still returns
the fixture. Their `performSettingsAudit()` leaves out the Dynamic Type and
clipping checks, which the iOS 27 Simulator fails for the system's list text
in headers, footers, and rows, and whose text size changes scroll a long list
while the contrast check samples it. It passes over contrast failures for rows
beneath the navigation bar's blur or past the screen's edge, with or without
an element, using the same `glassCovers()` as `performShellAudit()`.
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

### Account deletion

Delete account, last in Settings, follows the web's
[account deletion](../docs/data-and-access.md#account-deletion). The server
deletes only from a sign-in in the last ten minutes, so
`AccountDeletionSheet` (`Screens/Settings/DeleteAccountSection.swift`) takes
three steps, which `AccountDeletionModel` (ScreenrKit `Settings/`) tracks:

1. **Confirm it's you:** the sign-in screen's `SignInControls`
   (`Screenr/SignIn/`), driven by a `SignInModel` made with
   `confirming: MemberConfirmation`. It offers only the account's methods:
   an email code to the account's address, which cannot change, and Apple
   or Google when they are connected. It sends no invitation, and each
   sign-in is `.confirming(userId:)`: the client keeps the new token only
   when Better Auth's response names the signed-in member. A sign-in that
   reaches another account, which Sign in with Apple or Google can, fails
   with `APIError.Kind.otherAccount`, keeps the member's session, and signs
   the other account's new session out.
2. **Confirm the deletion:** Delete my account opens a confirmation dialog,
   which iOS 27 shows as a popover.
3. **Delete:** `.deleteAccount` ends the session with `ending`
   `.accountDeleted`. The client removes the token and its screen cache, and
   the `SessionStore.onEnd` handlers empty the image cache, forget any kept
   invitation, clear the error-reporting user, and reset the shell. Sign-in
   then says "Your Screenr account was deleted." The server erases the
   account's push devices with its sessions. The app does not register for
   push yet; when it does, its registration forgets its own state in an
   `onEnd` handler.

A 403, a sign-in more than ten minutes old, returns to step 1 with the
server's message. Any other failure, such as the 503 when Sign in with Apple
could not be disconnected, keeps step 2 with its message, so the member can
try again. `AccountDeletionModelTests` cover the steps against canned
replies and the fixture API, and `AccountDeletionTests` take the journeys
with the `actions/delete-account` fixtures: success, `stale-sign-in`, and
`apple-unavailable`.

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
| `Avatar`, `PosterImage`, `FlowLayout`, `.muted`, `.danger`, `.onAccent` | `Screenr/Shared/` | A member's photo or initial on the web's colors; a TMDB poster or the title's initial; a row that wraps; and text colors that keep 4.5:1 contrast, which the system's secondary label and red miss at small sizes, and the system's white misses on the dark theme's lime accent. |
| `.buttonStyle(.accent)` | `Screenr/Shared/AccentButtonStyle.swift` | The prominent accent-filled button, such as Accept, Send sign-in code, or Join Screenr, with its label in `.onAccent`. Use it in place of `.borderedProminent`. |
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
  keyboard or past the screen's edges, and Dynamic Type for scrolling
  content, which larger text moves past the screen's ends. To check large
  text, launch with
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
grow with Dynamic Type. `ListHeader` and `SymbolText` in `Screenr/Shared/`,
which Friends and Watch together use too, and `EmptyListMessage` in
`Screenr/Find/` stand in for them.

Suggestions and Friends recommend open title pages at `suggestion.destination`
and `recommendation.destination`, so the title page's Want to watch reports
the web's `suggestion`, `suggestion_recommendation`, or `friends_recommend`
surface. Search results open `Destination.title(id:)`, which reports `title`.

### Title lists

Views that list titles share these pieces:

| Piece | Where | What it does |
| --- | --- | --- |
| `TitleRow` | `Screenr/Shared/Titles/` | A title's `PosterImage`, name, kind and year, and where it streams, with optional lines after them. As on the web at phone widths, it leaves out the overview. At accessibility sizes the text moves beneath the poster. Put it in a `NavigationLink`. |
| `ViewingLinesView` | `Screenr/Shared/Titles/` | "On Netflix, Hulu" and "Free on Tubi TV", with saved services marked, or why there are no options. `savedBy: .eitherPerson` marks either person's services, as Watch together does. |
| `Title.kindAndYear` | ScreenrKit `Titles/` | "Movie · 2024", or only the kind without a release date. |
| `TitleViewing.matchingServices(_:)`, `access(for:)`, `lines(savedServices:savedBy:)` | ScreenrKit `Titles/` | The viewer's saved services that offer a title, whether the viewer can watch it, and the lines `ViewingLinesView` shows. |
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

## Friends and profiles

Friends, profiles, and Watch together follow the web's People, profile, and
Watch together pages. Their screens are `FriendsView`, `ProfileView`, and
`WatchTogetherView` in `Screenr/Screens/`, with their parts in
`Screenr/People/`, and their behavior is in ScreenrKit's `People/`.

| Piece | Where | What it does |
| --- | --- | --- |
| `FriendsSections`, `FriendsModel` | ScreenrKit `People/` | Friends in the web's order: Requests, Friends, Sent requests, People you may know with their mutual friends, and Blocked people. Accept, Decline after a confirmation, Cancel, Send friend request, and Unblock go through `relationship`, one at a time, and the page reads again after each. A failed action's message stays with its person. `searchDestination` opens an exact username's profile. |
| `Relationship`, `ProfileModel` | ScreenrKit `People/` | `Relationship(profile, viewer:)` is `own`, `friend`, `requestSent`, `requestReceived`, or `none`, and gives the visible `action`, such as Watch together or Accept friend request, and the More actions `menu`. Unfriend and Block confirm in the web's words. |
| `WatchTogetherFilter`, `WatchTogetherSection` | ScreenrKit `People/` | All, Movies, and TV; Ready to watch, Not on your services, and Availability unknown; and the count and empty states. Each shared title is a [`TitleRow`](#title-lists) that marks the services either person saved. |
| `TopTenSection`, `TopTenRow` | `Screenr/Shared/TopTen/` | A profile's Top 10 heading and its row of ranked posters, each a link named like "#1 Night Crossing" that opens the title. The row only displays the list. Another member's empty list shows nothing; the owner's explains how to start one. `TopTenSection(entries:owner: .viewer(edit:))` adds Edit to the heading. |
| `PersonLabel` | `Screenr/Shared/` | A member's avatar, name, and @username for a list row; `.nameOnly` for a blocked person. |
| `ProfileLinksText` | `Screenr/People/` | A line of text whose names link to profiles, such as "Mutual friends: Ben Ortiz (@ben), Cam Rivera (@cam)". |

- **Privacy:** the screens show what the server sends, which already applies
  the [privacy boundary](../docs/product-brief.md#privacy-and-the-known-people-circle--2026-09-07).
  Anyone who can see a profile gets the person, the relationship action, the
  top 10, and the friends list. Activity shows only when `canRead`; others
  read "You’ll see their activity after you become friends." A blocked
  person shows only their name, without a link.
- **Activity:** a profile's entries use the shared `FeedList` in its full
  style, with the profile's header, top 10, and friends above them.
- **Block:** Block hides the profile, so after it succeeds, `ProfileModel`
  closes the person's profile and Watch together on every tab with
  `Router.close(where:)`, leaves "You blocked …" for Friends with
  `ShellModel.leaveNotice(_:on:)`, and opens Friends. Friends shows the
  notice until it is dismissed or Friends is left.
- **The member's own profile:** the You tab's root is `ProfileView` with
  `Relationship.own`: no relationship action or More actions, and the top
  10's empty state. Its `editTopTen` closure adds Edit to the Top 10 heading
  while the list has titles; the top 10 editor sheet hooks in there, for
  example by giving `DestinationView`'s profile case a closure that presents
  it.
- **Watch together:** a friend's profile links to
  `/watch-together?with=<username>`. Save your streaming services opens
  Settings over the tab, and each title opens its page through
  `SharedTitle.destination`, so a Want to watch saved there reports the web's
  `watch_together` surface.
- **Tests:** `FriendsModelTests`, `ProfileModelTests`, and
  `WatchTogetherTests` cover the models against the fixtures and
  `RecordingAPI`. The UI tests `FriendsTests`, `ProfileTests`, and
  `WatchTogetherTests` drive the journeys, check each write in the request
  log, audit at the largest text size, and render every `screen/people`,
  `screen/profile`, and `screen/watch-together` fixture. `app.person(_:)`
  finds a Friends row by username, `ScreenFixtureFile` reads a screen
  fixture's viewer, path, and body, and `app.openFixture(_:)` opens its link
  in the running app, so one launch for each viewer renders all of that
  viewer's fixtures. Accept, Send friend request, and Watch together use
  `.buttonStyle(.accent)`, and `FriendsTests` measures their labels with
  `labelContrast()` in dark mode.
- **iOS 27 controls:** a confirmation dialog is a popover without Cancel;
  tap `PopoverDismissRegion` to cancel, and `app.popovers.buttons[…]` to
  confirm.

## Share extension

`ScreenrShare`, which the app embeds, puts Screenr (Screenr Dev in the
Simulator) in every app's share sheet for one web link or for text
([decision](../docs/ios-app.md#sharing-and-later-native-extras--2026-10-13)).
A link from Netflix, IMDb, TMDB, JustWatch, or Safari opens its title, where
the member can Recommend it or mark it Want to watch:

1. **Reading the share:** `SharedContent.load(from:)` takes the first web
   link and the first text: a text attachment, or else the item's own text
   or title, which is where Safari puts the page's title.
2. **Finding the title:** `ShareModel` sends both to `resolve-title`, which
   places TMDB, IMDb, and JustWatch links and gives a search for the rest
   ([shared links](../docs/title-catalog.md#shared-links)). It gives up after
   `ShareTiming.deadline`, 20 seconds, since the server may read a JustWatch
   page and TMDB. A search starts from the server's `query` in a `FindModel`,
   as Find a title's does, and a result opens its title. A failure offers Try
   again and Search for it.
3. **The title:** `ShareTitleModel` reads the title page once with a
   `ScreenModel`, without polling, and keeps a `TitlePageModel` for Recommend
   and Want to watch, so the title page's rules hold: Want to watch replaces
   another status, withdrawing or switching a top 10 title's Recommend asks
   first, and every write reads the page again. Want to watch reports the
   `title` save surface. Friends who recommend the title or want to watch it
   show beneath.
4. **The session:** the extension reads the app's session token from the
   shared Keychain group and never signs in. Signed out, it asks the member
   to sign in in the app; a 426 shows Update Screenr; a member without a
   profile gets the server's 403, and is sent to the app to finish joining.

| Piece | Where | What it does |
| --- | --- | --- |
| `ShareViewController` | `ScreenrShare/` | The principal class. It builds `AppServices(…, host: .shareExtension)`, whose client marks no [visits](#visits), with `Telemetry.localOnly()`, logs to `share.ndjson` in the app group's log directory, hosts `ShareView`, and closes the sheet. |
| `ShareView`, `ShareSearchView`, `ShareTitleView` | `ScreenrShare/` | The views, in a navigation stack with the system Close button. Large text stacks posters above names. |
| `SharedContent`, `ShareModel`, `ShareTitleModel` | ScreenrKit `Share/` | The behavior above. |
| `FixtureHandoff` | ScreenrKit `FakeAPI/` | Screenr Dev keeps its fixture launch arguments in the app group, so the extension, which the system starts without arguments, answers from the same fixtures. A launch without fixtures forgets them; Release builds neither keep nor read them. |

- **Activation:** its `Info.plist` accepts at most one web link
  (`NSExtensionActivationSupportsWebURLWithMaxCount`) or text
  (`NSExtensionActivationSupportsText`).
- **Extension rules:** `Config/ScreenrShare.xcconfig` sets
  `APPLICATION_EXTENSION_API_ONLY`, and ScreenrKit uses nothing that
  extensions cannot. The extension shares the app's version and build, and
  the app's `Assets.xcassets` through a target membership exception, for the
  `AccentColor` tint; the icon sets compile only into the app.
- **Sentry:** the extension never starts Sentry. `Telemetry.localOnly()` logs
  its API calls, and the [feedback form](#feedback) attaches its log.
- **Signing:** the bundle ID is the app's with `.Share`, and
  `Config/ScreenrShare.entitlements` holds only the app group. See
  [Apple Developer](../docs/running-screenr.md#apple-developer).
- **Tests:** `SharedContentTests`, `ShareModelTests`, and `ShareServicesTests`
  cover ScreenrKit's part, and `tests/app/shared-links.test.ts` the server's.
  No UI test drives the extension: the system starts it only from another
  app's share sheet, and Safari's needs a live page. Check it in your
  Simulator instead: launch Screenr Dev with fixture arguments, such as
  `-ScreenrFixtures "$PWD/ios/ScreenrKit/Fixtures" -ScreenrFixtureLog
  /tmp/requests.log`, open a TMDB or IMDb title in Safari, and choose Page
  Menu, Share, then Screenr Dev. The fixture API answers `resolve-title`
  with the fixture for the same query, or another title's, and the request
  log shows what the extension sent and wrote. Real links resolve only
  against a server, such as `npm run dev` with a TMDB token. Use a
  Simulator you will not pass to `bin/check-ios --simulator`: the
  extension's log stays in the app group, and `SettingsTests` expects
  feedback to attach only the app's.

## Siri, Shortcuts, and Spotlight

Siri and the Shortcuts app can save a title to Want to watch and read or open
Friends recommend, and Spotlight on the iPhone finds the titles the member
has interacted with
([decision](../docs/ios-app.md#sharing-and-later-native-extras--2026-10-13)).
The behavior is in ScreenrKit's `Shortcuts/` and `Spotlight/`; the App
Intents are in `Screenr/Shortcuts/`.

| Piece | Where | What it does |
| --- | --- | --- |
| `ShortcutActions` | ScreenrKit `Shortcuts/` | What the intents do: `search(_:)`, `titles(_:)` for a saved shortcut's title IDs, `addToWantToWatch(_:)`, `wantToWatchSuggestions()`, `friendsRecommend()`, and `openFriendsRecommend()`. Each fails with a `Failure` whose message Siri can say. |
| `TitleSummary` | ScreenrKit `Titles/` | A title's ID, name, kind, year, and poster, with `isTitleID(_:)` to check an ID that Spotlight or a shortcut kept. |
| `TitleSpotlight`, `InteractedTitles`, `SpotlightIndex` | ScreenrKit `Spotlight/` | Which titles each screen shows the member interacted with, the writes that keep the index in step, and the `CSSearchableIndex` items. |
| `TitleEntity`, `TitleQuery` | `Screenr/Shortcuts/` | A title in Siri and the Shortcuts app, found by name with search and suggested from Friends recommend. |
| `AddToWantToWatchIntent`, `FriendsRecommendIntent`, `OpenFriendsRecommendIntent`, `ScreenrShortcuts` | `Screenr/Shortcuts/` | The intents and their App Shortcuts, which need no setup: "Add to Want to watch in Screenr", "What do my friends recommend in Screenr", and "Open Friends recommend in Screenr". |

- **Process:** the intents run in the app's process. `ScreenrApp` registers
  its `ShortcutActions`, built on the app's client, session, router, and
  Spotlight, with `AppDependencyManager`, and the intents and the query read
  it with `@Dependency`. Without a session, each action says "Sign in to
  Screenr to use this shortcut."
- **Add to Want to watch:** asks "Which movie or show?", suggests the titles
  in Friends recommend that the member neither recommends nor has a status
  for, and finds others by name through `search`. It reads the title's page
  first and saves only when the member has no status and no Recommend for
  it; otherwise it says what they have and leaves the title page to change
  it. A save sends the `shortcut`
  [save surface](../docs/usage-telemetry.md#save-attribution) and joins
  Spotlight.
- **Friends recommend:** "What do my friends recommend?" names the first
  three titles that are not finished, as the tab first shows them, such as
  "Your friends recommend Night Crossing, Harbor Lights, and Winter Garden.",
  and returns them to the shortcut. Open Friends recommend opens the app at
  Find a title's Friends recommend.
- **Visits:** the actions read screens with `.screen(path:visit: .never)`, so
  they never carry the app's [visit](#visits), which stays due for the
  app's next screen.
- **Spotlight index:** `ShellModel`'s `onScreen` hands `TitleSpotlight` every
  screen that loads. A feed or profile entry names the viewer's Recommend,
  status, and top 10 rank for its title, and the viewer's own review counts
  too; Friends recommend names their status and Recommend. A title page
  without any of these removes its title. Each title is indexed once per
  launch until it changes, so polls write nothing, and the writes run in
  order. An item's identifier is the title ID, with its name, "Movie · 2024",
  and the poster when the image cache already holds it, so indexing
  downloads nothing. Nothing leaves the device.
- **Opening a result:** selecting a result continues
  `CSSearchableItemActionType`, and `AppRootView` opens the title with
  `router.open(_:)`, as a link would.
- **Clearing:** when the session ends, by signing out, the server ending it,
  or deleting the account, `SessionStore.onEnd` removes every item. A launch
  without a session removes them too, since the session may have ended in
  another process.

`ShortcutActionsTests` runs the actions against the fixture API and checks
the request log; `actions/search/winter` finds Winter Garden, which Alice has
not saved, and `actions/activity/shortcut` saves it. `TitleSpotlightTests`
checks the index's writes against a recording index. UI tests do not drive
the Shortcuts app or Spotlight, whose interfaces belong to the system. To
check them in a Simulator, launch Screenr Dev with the fixture launch
arguments and leave it running, since the intents run in that process; the
system otherwise launches the app without them, against the server. Then:

- **Shortcuts:** open Shortcuts, then Library, Apps, and Screenr Dev, and tap
  an App Shortcut. Add to Want to watch suggests Winter Garden and says
  "Added Winter Garden to Want to watch."; the request log shows the save.
- **Spotlight:** swipe down on the Home Screen and search for a title in
  Alice's feed, such as Paper Lanterns. Selecting the Screenr Dev result
  opens its page. After signing out, the search finds no Screenr Dev result.

Use a Simulator you will not pass to `bin/check-ios --simulator`: typing in
Spotlight and Safari leaves keyboard predictions, whose cells fail the
accessibility audit in tests that type. Siri's spoken phrases need a device.

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
Another process writes a file of its own name in the same directory, such
as the [share extension](#share-extension)'s `share.ndjson`, and
`recentTails(maximumBytes:)` returns each file's newest lines for the
[feedback form](#feedback).

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
