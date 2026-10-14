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
| `Config/` | The `.xcconfig` build settings and the app's entitlements. |
| `Screenr/` | The app target: SwiftUI views, the app lifecycle, assets, and `Info.plist`. |
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
| `APIError` | `API/APIError.swift` | `kind`, the server's `message`, and the `requestID` the request sent. `isPermanent` says whether polling should stop. |
| `APIRequestObserver` | `API/APIRequestObserver.swift` | Sees every finished request: route pattern, request ID, status, duration, and error. Logging attaches here. |
| Models | `Models/` | `Screens.swift`, `Feed.swift`, `Titles.swift`, `People.swift` (members and notifications), and `Results.swift` (other actions and `ErrorBody`). |
| `AppServices` | `AppServices.swift` | The client and session together, injected with `.screenrServices(_:)`. |

- **Headers:** every request sends `Screenr-Client: ios/<version>/<build>`
  and a new `Screenr-Request-Id`, plus `Authorization: Bearer <token>` while
  signed in. It never sends cookies or an `Origin`.
- **Session:** a sign-in request stores the token from `set-auth-token` in
  the Keychain, and `.signOut` removes it. A 401 to a request that carried a
  token removes that token, unless a newer one replaced it.
- **Caching:** each GET's response is kept in memory with its ETag. Reading
  the same path again sends `If-None-Match`, and a 304 returns the cached
  value. Signing in or out clears the cache.
- **Errors:** 401, 403, 404, 408, 426, 429, other 4xx, and 5xx each have a
  kind, as do no response, a timeout, cancellation, and an unreadable body.
  A 426 also moves `SessionStore.phase` to `.updateRequired`. A signed-in
  person who has not finished setup gets `.forbidden` with "Complete your
  profile first." from every action except `setup` and the photo actions.
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
| `-ScreenrFixtureOverride` | A fixture that answers first, such as `screen/feed/empty`. Repeatable. |
| `-ScreenrFixtureFailure` | A fixture that answers every `/api/screenr` request, such as `errors/update-required`. |

In UI tests, `app.launch(with: FixtureLaunch(viewer: "nora"))` passes them,
with the directory found from the test's source path. The fixture API keeps
the session in memory, and signing in always succeeds. A request gets the
fixture with the same action and query or body, then falls back to the
screen's path or to a successful fixture for the action. A matching ETag
gets 304.

## Fixtures

Server tests write JSON fixtures into `ScreenrKit/Fixtures/`. The directory
is outside the package's targets, so tests find it from their own source
path, as `TestFixtures.directory` in `Tests/ScreenrKitTests/Support/` does.
This works under `swift test` and in the Simulator, which reads the Mac's
file system. `FixtureDecodingTests` decodes every fixture as the model its
action returns, and `RequestTests` checks that the request functions build
the recorded requests.

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
