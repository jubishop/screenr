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
| `Screenr.xcodeproj` | The Screenr app, the ScreenrShare and ScreenrNotificationService extensions, the ScreenrAppTests and ScreenrUITests targets, and the shared Screenr scheme. |
| `Config/` | The `.xcconfig` build settings, the app's and extensions' entitlements, and the release export options. |
| `Screenr/` | The app target: the [app shell](#app-shell) in `Shell/`, feature screens in `Screens/` with their parts in a folder named for the feature, such as `Find/` and the [title page](#title-pages)'s `TitlePage/`, components several features share in `Shared/`, such as the [title list views](#title-lists), the [conversations](#conversations) that the feed, title pages, and profiles share in `Conversation/`, the iOS side of [push notifications](#push-notifications) in `Push/`, the app lifecycle, assets, and `Info.plist`. |
| `ScreenrShare/` | The [share extension](#share-extension), which the app embeds: its view controller, views, and `Info.plist`. |
| `ScreenrNotificationService/` | The Notification Service Extension that builds [push content](#push-content), which the app embeds: its entry point and `Info.plist`. |
| `ScreenrAppTests/` | [Hosted tests](#hosted-tests) that run inside Screenr Dev. |
| `ScreenrUITests/` | XCUITest UI tests. |
| `ScreenrKit/` | A local Swift package: `Sources/ScreenrKit`, `Tests/ScreenrKitTests`, and `Fixtures/`. |
| `build/` | Build output, check logs, and result bundles. Git ignores it. |

`Screenr/`, `ScreenrShare/`, `ScreenrNotificationService/`, `ScreenrAppTests/`, and `ScreenrUITests/` are synchronized folders:
a file added on disk joins its target with no `project.pbxproj` change.
ScreenrAppTests also compiles `ScreenrNotificationService/`'s sources. The
Screenr scheme builds the app with its extensions and tests ScreenrKit, the
hosted tests, and the UI tests. Xcode also lists
an automatic ScreenrKit scheme for the package.

## Variants

The Debug configuration builds Screenr Dev, and the Release configuration
builds Screenr. Xcode builds local packages without optimization only under
a configuration named Debug, so the names stay Debug and Release.

| Setting | Screenr Dev (Debug) | Screenr (Release) |
| --- | --- | --- |
| Bundle ID | `com.artisanalsoftware.Screenr.dev` | `com.artisanalsoftware.Screenr` |
| Share extension | `com.artisanalsoftware.Screenr.dev.Share` | `com.artisanalsoftware.Screenr.Share` |
| Notification extension | `com.artisanalsoftware.Screenr.dev.NotificationService` | `com.artisanalsoftware.Screenr.NotificationService` |
| Server | `http://localhost:3000` | `https://screenr.club` |
| App group and Keychain group | `group.com.artisanalsoftware.Screenr.dev` | `group.com.artisanalsoftware.Screenr` |
| APNs | `development` | `production` |
| Links | `screenr-dev://` | Universal links for `screenr.club` |
| Icon | `DevAppIcon`, lime | `AppIcon`, deep green |

`Config/Base.xcconfig` holds the shared settings, `Dev.xcconfig` and
`Release.xcconfig` the variant values, and `Screenr.xcconfig`,
`ScreenrShare.xcconfig`, `ScreenrNotificationService.xcconfig`, and
`ScreenrUITests.xcconfig` the target settings.
`Config/Version.xcconfig` holds the marketing version; local builds are build
1, and release builds take the next number from the release tags, which the
extensions share. `Screenr/Info.plist` passes the variant, server, and app
group to the app, which reads them through ScreenrKit's `AppConfiguration`,
as each extension's `Info.plist` does for it. The app's also passes
its APNs environment, which `AppConfiguration.pushTarget(infoDictionary:)`
reads. Xcode preprocesses these files, so Dev-only keys sit in an
`#if SCREENR_DEV` block.

## Checks

```sh
bin/check-ios
bin/check-ios --simulator <UDID>
bin/check-ios --reuse
bin/check-ios --test-timeout <minutes>
```

`bin/check-ios` fails on any failed or skipped test and on any warning, from
the compiler, linker, or tools. It resolves the app's packages into the
[shared package cache](#package-cache), then runs:

1. ScreenrKit's tests on the Mac with `swift test`.
2. A Release build for the Simulator.
3. The Screenr scheme's tests in an iPhone Simulator: ScreenrKit's tests
   again, on iOS, the [hosted tests](#hosted-tests), and the UI tests. It
   first boots the Simulator and waits with `xcrun simctl bootstatus` until
   the boot finishes, since a new Simulator's first boot can otherwise
   outlast a UI test's launch timeout on a slow Mac. Then it marks the
   keyboard's slide-to-type introduction as shown
   (`DidShowContinuousPathIntroduction` in
   `com.apple.keyboard.preferences`). A Simulator shows it once, over the
   keyboard, at an early keyboard appearance, and the test that meets it
   depends on every earlier test's keyboard. On 2026-11-05 it covered the
   Post button of a push's reply field in `PushTests`; see
   [run one test](#run-one-test) for a Simulator of your own. Meanwhile
   it delivers the pushes the UI tests ask for; see
   [push tests](#push-tests).

Without `--simulator`, it creates a Simulator on the newest iOS runtime and
deletes it afterward, so several checkouts can check at once. With
`--simulator`, it uses that Simulator and leaves it in place. Logs and result
bundles from the last run are in `ios/build/check/`.

Each run builds on the last run's output: ScreenrKit's in
`ios/build/ScreenrKit` and the app's in `ios/build/DerivedData`. A package
update, such as a sentry-cocoa bump, replaces framework headers that modules
there were built against, and those modules then fail to load ("has been
modified since the module file was built"). So the check records, in
`ios/build/packages.stamp`, the hash of `ios/ScreenrKit/Package.resolved`
and the [package sources](#package-cache) directory the builds used. When
either differs from the recorded one, or nothing is recorded, the check
removes both directories before it builds. Each checkout keeps one copy of
each. The commands below that reuse those directories don't check; after a
package update, run `bin/check-ios` first or remove them.

At most three checks run at once on the Mac, since more load it enough to
make accessibility audits time out. Before its first step, a check waits for
a free machine-wide slot, printing that it is waiting, and holds it until it
exits; see
[slots](../docs/development-workflow.md#ios-checks-before-a-push).

The check fails fast and never hangs:

- **Diagnostics:** the test run passes `-collect-test-diagnostics never`.
  Collecting a sysdiagnose after a failed UI test took about 10 minutes and
  sometimes never finished.
- **Timeouts:** the Simulator tests stop and fail after 60 minutes, or after
  `--test-timeout <minutes>`, the ScreenrKit tests and the Release build
  after 30 minutes each, the Simulator boot after 10, and the package
  resolution after 15. The failure names the step and shows the end of its
  log. Simulator tools can hang under heavy load, so each tool call, such as
  `xcrun simctl create` or `xcrun xcresulttool get`, stops after 5 minutes
  and fails the check with its command. A push that `xcrun simctl push` has
  not sent within 20 seconds fails the test that asked for it.
- **Cleanup:** shutting down and deleting the check's Simulator have the same
  5-minute limit but never change the check's result. A Simulator the check
  could not delete is reported with its UDID and the command that deletes
  it. A check stopped with `SIGKILL` never deletes its Simulator, which held
  about 3 GB on 2026-11-05. So before a check creates its Simulator, it
  deletes any that earlier checks left behind, the same way, and names them.
  Each check names its Simulator `screenr-check-<checkout>-<pid>` after its
  process ID. One whose process has ended is deleted. One whose process ID is
  in use may be another checkout's running check and is left alone, so a
  reused ID only delays a deletion. Simulators named otherwise are never
  touched.
- **Stopping:** each step runs in its own process group. A timeout,
  Control-C, or `SIGTERM` stops that group: `SIGTERM` first, then `SIGKILL`
  for whatever is left after 5 seconds. The check then deletes its Simulator.
  Stop a check by signaling `bin/check-ios` itself, never by killing
  `xcodebuild`.

The check's inputs, the iOS files, are `ios/`, except Markdown directly in
it, and `bin/format-swift`. A pass on a checkout whose
iOS files match `HEAD` is recorded for those exact files and the Xcode
version. With `--reuse`, the check skips itself when those files passed with
the same Xcode in the last 7 days.

There is no iOS CI. Run `bin/check-ios` before every push that changes
`ios/`. The `pre-push` hook refuses such a push at once unless a recorded
pass covers the pushed files, and never runs the check itself; never bypass
it with `--no-verify`. See
[iOS checks before a push](../docs/development-workflow.md#ios-checks-before-a-push).
On a Mac, `bin/check --full` runs `bin/check-ios --reuse` when the iOS files
differ from where the branch left `origin/main`, including uncommitted and
untracked files. On Linux it skips the iOS checks.

### Package cache

The app's packages are mostly sentry-cocoa's prebuilt frameworks, about
3.5 GB for each release once resolved. Before
[#381](https://github.com/jubishop/screenr/issues/381), every checkout that
ran the check resolved its own copy into `ios/build/DerivedData`. Now
`bin/check-ios`, the
[TestFlight archive](../docs/development-workflow.md#testflight-releases),
and `bin/ios-packages` share one cache on the Mac, outside every checkout:
`~/Library/Caches/screenr-ios-packages`. `bin/_ios_packages.py` manages it.

- **Sources:** xcodebuild resolves the packages into `sources/<hash>/`, named
  for the hash of `ios/ScreenrKit/Package.resolved`, through
  `-clonedSourcePackagesDirPath`, and builds against them there. Checkouts
  with the same `Package.resolved` share one copy. One on another version
  gets its own directory, so neither changes the sources the other builds
  against. `-onlyUsePackageVersionsFromResolvedFile` keeps each directory to
  the versions it is named for: a `Package.resolved` that no longer matches
  `Package.swift` fails the resolution.
- **Downloads:** xcodebuild's `-packageCachePath` and SwiftPM's
  `--cache-path` both point at `swiftpm/`, so each release is downloaded
  once, and not into SwiftPM's default `~/Library/Caches/org.swift.swiftpm`.
  SwiftPM keeps the packages it resolves in its scratch path, beside its
  build, and has no option to put them elsewhere. So `swift test` still
  extracts its own copy into `ios/build/ScreenrKit` from those downloads, and
  the check clears it with the rest of that directory.
- **Locks:** a command resolves packages into the cache, or deletes it, only
  while it holds `resolve.lock` exclusively, so two never write it at once;
  another command waits, saying so. Before letting go, it takes `users.lock`
  shared, and holds it until it exits, so nothing deletes the cache while it
  builds. A check takes its [slot](#checks) before the cache's locks, and
  nothing that holds those waits for a slot, so they cannot deadlock.
- **Size:** when the cache holds more than 12 GB, more than two releases'
  packages, the next command deletes everything in it but its locks, then
  resolves again. A fresh resolution downloads about 1 GB, and took under 30
  seconds on 2026-11-04. If another command holds the cache in use, the
  command says so and leaves the deletion to a later one.

Run other `xcodebuild` and `swift` commands through `bin/ios-packages`, as
below. `bin/ios-packages xcodebuild <arguments>` resolves the packages and
adds the options that build against them, and
`bin/ios-packages swift <subcommand> <arguments>` adds `--cache-path`. Both
hold the cache in use while the command runs and exit with its status. A
plain `xcodebuild` resolves another 3.5 GB copy into its derived data
instead, and its build then differs from the check's.
`tests/test_ios_packages.py` covers the cache, and `tests/test_check_ios.py`
the check's use of it.

`swift test` keeps its own copy. On 2026-11-04,
[#494](https://github.com/jubishop/screenr/issues/494) compared it with
running ScreenrKit's tests on the Mac through xcodebuild against the shared
sources. After a run, `ios/build/ScreenrKit` held 3.7 GB: 3.3 GB of all
seven sentry-cocoa frameworks, 0.2 GB of sentry-cocoa's Git repository and
checkout, and 0.3 GB of build. xcodebuild's run added only 0.3 GB of build
to `ios/build/DerivedData`, but it doesn't check what `swift test` checks:

- **Unhandled files:** SwiftPM warns about a file in a target's folder that
  the target doesn't handle, such as Markdown in
  `ios/ScreenrKit/Sources/ScreenrKit/`: "found 1 file(s) which are
  unhandled". xcodebuild printed no warning for such a file and counted none
  in its result bundle, whether it tested ScreenrKit through a scheme in the
  project or through the package's own scheme, and the check's Release build
  passed with it too. `swift test` is the only step of the check that fails
  on one. The Simulator tests run ScreenrKit's tests as well, but dropping
  the step for them would lose that check too.
- **Compiler checks:** both tools apply `Package.swift`'s settings. They
  failed alike on an unused value, unsafe pointer use not marked `unsafe`,
  global mutable state, and `Error` without `any`, in the package and in its
  tests, and both ran the same 678 tests.
- **Noise:** xcodebuild prints the test process's system log. On the Mac,
  every run of all the tests logged CoreData `warning:` lines about the
  Contacts store, which the check would count as warnings. xcodebuild would
  also need a new shared scheme, since the project's ScreenrKit scheme has no
  test action, and a destination that names the Mac's architecture:
  `platform=macOS` matched several and printed a warning.
- **Time:** at a load average near 20, both took about 38 seconds from an
  empty build directory, where `swift test` also extracts the frameworks.
  With a build in place and no change, `swift test` took 10 to 11 seconds
  and xcodebuild 17; after a one-file change, 12 to 13 and 19.

SourceKit-LSP, the Swift language server that editors and agents' language
tools start when they open a Swift file, keeps one more copy of the packages
in each checkout where it has opened a ScreenrKit file: its index build, by
default in `ios/ScreenrKit/.build/index-build`. Its background indexing
resolves the packages and builds ScreenrKit's modules there, apart from the
check's builds, and that is what lets a test file see ScreenrKit's module and
report diagnostics. It holds only one release: when `Package.resolved`
changes, SwiftPM removes a package's old frameworks before it extracts the
new ones. It goes away with its worktree. SourceKit-LSP has no option for
another download cache, so it downloads into SwiftPM's default one,
`~/Library/Caches/org.swift.swiftpm`, which nothing prunes.

On the owner's Mac, a user-level SourceKit-LSP configuration file,
`~/.sourcekit-lsp/config.json`, has SourceKit-LSP prepare packages with Swift
Build, SwiftPM's newer build system, instead of its default native build
system, which leaves Sentry's types unresolved, as described below. The owner
opted in on 2026-11-05
([#516](https://github.com/jubishop/screenr/issues/516)): Swift Build is the
direction for SwiftPM's builds, the setting affects only language tools'
index builds, not `swift` or `xcodebuild` commands or `bin/check-ios`, and
deleting the file undoes it. The file holds:

```json
{
  "swiftPM": {
    "buildSystem": "swiftbuild",
    "scratchPath": ".build/index-build"
  }
}
```

- **Index build:** on 2026-11-05 a fresh one held 3.8 GB: 3.3 GB of all seven
  sentry-cocoa frameworks, the same files as the cache's, 0.3 GB of build and
  index, and 0.2 GB of sentry-cocoa's Git repository and checkout. The native
  build system's held 4.3 GB on 2026-11-04, 0.8 GB of it build and index.
  Swift Build copies `Sentry.framework` into the build's
  `out/Products/Debug` while preparing, so ScreenrKit's files resolve
  `SentrySDK`, `Event`, and `SentryFeedback`, with go-to-definition into
  Sentry's headers.
- **Location:** the SourceKit-LSP in Xcode 27.2 passes `scratchPath` to Swift
  Build as written, and Swift Build resolves it against the directory the
  language server started in, not the package's. Agents' language tools start
  it at the checkout's root, so their index build is the checkout's
  `.build/index-build`; an editor that starts it in `ios/ScreenrKit` puts it
  in `ios/ScreenrKit/.build/index-build`. `.gitignore` ignores both. Upstream
  SourceKit-LSP resolves the path against the package since
  [swiftlang/sourcekit-lsp#2692](https://github.com/swiftlang/sourcekit-lsp/pull/2692),
  which Xcode 27.2's doesn't include. Without `scratchPath`, Swift Build would
  build in `ios/ScreenrKit/.build`, where a `swift` command run without
  `--scratch-path` also builds.
- **Scope:** the file applies to every Swift package on the Mac, not only
  ScreenrKit, and departs from SourceKit-LSP's default, which its maintainers
  keep for background indexing while Swift Build's issues are worked out. A
  running language server picks it up only when it restarts. A user-level file
  needs no trust prompt: sessions started at the checkout's root and in
  `ios/ScreenrKit` showed none on 2026-11-05.

No file in the repository can move the index build or turn it off. The
SourceKit-LSP in Xcode 27.2 reads a checkout's
`ios/ScreenrKit/.sourcekit-lsp/config.json`, which can set its scratch path or
turn background indexing off, only after the editor answers a prompt to trust
that checkout's `ios/ScreenrKit`. On 2026-11-04 an agent's language tool left
the prompt unanswered, so with such a file in place the index build still
landed in `.build/index-build`, and a client that trusted it still resolved
the packages there before it moved to the file's scratch path. Turning
background indexing off would save only about 0.7 GB: SourceKit-LSP still
resolved the packages into `ios/ScreenrKit/.build`, and a test file then
reported "No such module 'ScreenrKit'".

Both copies' frameworks are the cache's files, byte for byte, with the same
modification times, which SwiftPM takes from the archives. So `bin/check-ios`,
after its package tests, and `bin/ios-packages`, after its command, make them
APFS clones of the cache's files: `share_artifacts()` in
`bin/_ios_packages.py` ([#505](https://github.com/jubishop/screenr/issues/505)).
It covers `ios/build/ScreenrKit`, the index build, in either
`ios/ScreenrKit/.build/index-build` or the checkout's `.build/index-build`, and
`ios/ScreenrKit/.build`, where a `swift` command run without `--scratch-path`
builds, and says how much it shared. A clone shares its data with the cache's
file, so it takes no space until either changes, yet stays a file of its own:
SwiftPM replacing it, or the size bound deleting the cache, leaves the other
intact, which a symbolic link into the cache would not. Once the cache is
resolved again, the next command clones the new files.

- **Saving:** in two runs on 2026-11-05, a pass freed 3,329 MiB of the volume's
  free space, as `df` reports it, for one copy's frameworks, which take
  3,331 MiB on disk; a third, while two other checks were building, measured
  2,686 MiB. `du` counts a clone in full, so it shows no change. APFS's count
  of the bytes a file shares with no other (`ATTR_CMNEXT_PRIVATESIZE` from
  `getattrlist`) was none for each shared copy, and 3,289 to 3,331 MiB for
  each copy in four other checkouts, 26 GB in all. A checkout with both copies
  saves about 6.5 GB.
- **No race with SwiftPM:** SwiftPM replaces an artifact only when the checksum
  its `workspace-state.json` records for it differs from the one the package
  calls for, and records the new checksum only after extracting the files
  (`Sources/Workspace/Workspace+BinaryArtifacts.swift` in Swift 6.4.2). The
  pass touches only artifacts recorded with the cache's checksum for the
  checkout's `Package.resolved`, and in them only files with the cache file's
  size, mode, and modification time. It makes each clone beside the scratch
  path and renames it over the file, so a reader finds the old file or the
  clone, never neither. While SwiftPM resolved one scratch path three times,
  extracting the frameworks again each time, 267 to 284 passes ran during each
  resolution, and only the one after SwiftPM recorded the frameworks changed
  anything. Every resolution succeeded, with files identical to the cache's.
  Only a `Package.resolved` change during a pass, which takes a second or
  two, could let it rename a clone into a directory SwiftPM is removing,
  which would fail that resolution once.
- **Builds:** a clone keeps the file's modification time, so Clang's modules
  built against the headers stay valid. After a pass, the index build's
  preparation, the `swift build --experimental-prepare-for-indexing` that
  SourceKit-LSP runs, rebuilt nothing, and `swift test` compiled nothing but
  planned its build again and relinked its test bundle once, a few seconds,
  since its build system tracks the files themselves. With Swift Build, the
  index build's next preparation copied `Sentry.framework` into its products
  again, within a second, and rebuilt no module. So a pass skips files
  that already share the cache's data, by APFS's clone ID, and took about
  0.3 seconds for both copies when all did. A first pass took 1.1 to
  1.8 seconds per copy.
- **Reach:** SourceKit-LSP creates its index build outside any command, so the
  pass shares it at the checkout's next check or `bin/ios-packages` command. A
  checkout that runs neither keeps its copy until the worktree goes; a
  scheduled job could reach it, but at the cost of another job for a copy
  that lasts only as long as its worktree.
- **Otherwise:** the clones carry the cache files' `com.apple.provenance`
  attribute, as do the files the check's xcodebuild builds use, and
  `swift test` passed with it. On a system other than macOS the pass does
  nothing, so CI's Linux runners skip its tests in `tests/test_ios_packages.py`
  and `tests/test_check_ios.py`.
- **Choice:** about 6.5 GB for each checkout with both copies, 26 GB across
  the four on the Mac on 2026-11-05, is worth a pass of about 100 lines that
  runs within commands checkouts already run, needs no new job or dependency,
  and leaves every file's contents and modification time as they were.

With its default native build system, SourceKit-LSP resolves Foundation's
and ScreenrKit's types in ScreenrKit's files but none of sentry-cocoa's, so
language tools give no type, hover, or definition for `Event`, `SentrySDK`, or
`SentryFeedback` ([#513](https://github.com/jubishop/screenr/issues/513)). On
2026-11-05 a private SourceKit-LSP from Xcode 27.2, driven over its protocol
in a fresh index build, showed why:

- **Cause:** SourceKit-LSP prepares each target with
  `swift build --build-system native --experimental-prepare-for-indexing`.
  The compiler arguments, the editor's and preparation's alike, look for a
  binary target's framework only in the build's products directory,
  `-F .build/index-build/arm64-apple-macosx/debug`. They name the
  xcframework's macOS slice, which holds `Sentry.framework`, only with `-I`,
  which finds no module inside a framework. A full build copies
  `Sentry.framework` into the products directory; preparation doesn't, so
  `import Sentry` fails. Preparation printed `error: no such module 'Sentry'`
  for `SentryPrivacy.swift` and `SentryEnvelopeCapture.swift`, yet exited with
  status 0 and wrote `ScreenrKit.swiftmodule`, since it carries on past
  compiler errors. SourceKit-LSP then reported no diagnostics for either file,
  so an editor shows unresolved names, such as `let event: _`, and no error.
- **Not the clone pass:** the fresh index build failed the same way before
  any pass reached it, and the pass only replaces regular files under
  `artifacts/`.
- **Upstream:** SwiftPM closed the bug,
  [swiftlang/swift-package-manager#9567](https://github.com/swiftlang/swift-package-manager/issues/9567),
  as fixed by Swift Build, its newer build system, and
  [getsentry/sentry-cocoa#7472](https://github.com/getsentry/sentry-cocoa/issues/7472)
  points there. SourceKit-LSP still prepares with the native build system
  [on purpose](https://github.com/swiftlang/swift-package-manager/issues/9567#issuecomment-5090847059)
  while Swift Build's issues are worked out. Once it prepares with Swift Build
  by default, Sentry's types resolve with no change here.
- **Swift Build:** with `"swiftPM": {"buildSystem": "swiftbuild"}` in its
  configuration, SourceKit-LSP copied the framework while preparing and
  resolved every Sentry type, with go-to-definition into Sentry's headers and
  no diagnostics. It also indexed 10 batches of files instead of 217: 207 of
  the native build's come from sentry-cocoa targets that ScreenrKit never
  builds, such as `SentrySwift` and `SentryObjCInternal`. Its build and index
  took 0.3 GB instead of 0.8 GB.
- **Choice:** nothing in the repository can fix it. A workspace
  `ios/ScreenrKit/.sourcekit-lsp/config.json` choosing Swift Build takes effect
  only after the trust prompt above. A clone of the slice's framework in the
  products directory resolved Sentry's types in ScreenrKit's files, but test
  files kept the `ScreenrKit.swiftmodule` built without them, with false
  errors such as "Extra arguments" on `Telemetry(...)`, because preparation
  found ScreenrKit up to date. A pass in `share_artifacts()` would also reach
  an index build only at the checkout's next check or `bin/ios-packages`
  command. A user-level configuration file needs no prompt, but it applies to
  every Swift package on the Mac and departs from SourceKit-LSP's default, so
  it was the Mac owner's choice. The owner opted in on 2026-11-05, with the
  user-level file described above
  ([#516](https://github.com/jubishop/screenr/issues/516)).

## Run one test

ScreenrKit on the Mac, by suite or by test:

```sh
bin/ios-packages swift test --package-path ios/ScreenrKit \
  --scratch-path ios/build/ScreenrKit --filter AppConfigurationTests
```

In the Simulator, name the target and suite with `-only-testing`, such as
`ScreenrKitTests/AppConfigurationTests`, `ScreenrAppTests`, or
`ScreenrUITests/LaunchTests`:

```sh
bin/ios-packages xcodebuild test -project ios/Screenr.xcodeproj \
  -scheme Screenr -configuration Debug \
  -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath ios/build/DerivedData \
  -only-testing:ScreenrUITests/LaunchTests
```

On a new Simulator, first mark the keyboard's slide-to-type introduction as
shown, as `bin/check-ios` does, so it never covers what a UI test taps:

```sh
xcrun simctl spawn "$udid" defaults write com.apple.keyboard.preferences \
  DidShowContinuousPathIntroduction -bool true
```

## Run the Dev app

Use a Simulator of your own rather than one another checkout may have booted:

```sh
udid=$(xcrun simctl create screenr-dev "iPhone 18 Pro" \
  com.apple.CoreSimulator.SimRuntime.iOS-27-0)
xcrun simctl boot "$udid"
open -a Simulator
bin/ios-packages xcodebuild build -project ios/Screenr.xcodeproj \
  -scheme Screenr -configuration Debug \
  -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath ios/build/DerivedData
xcrun simctl install "$udid" \
  ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Screenr.app
xcrun simctl launch "$udid" com.artisanalsoftware.Screenr.dev
```

`xcrun simctl launch --console-pty` shows the app's output instead. Run
`xcrun simctl delete "$udid"` when you are done. The Dev app talks to the
local server that `npm run dev` starts on port 3000.

## Releases

`bin/testflight`, or its alias `bin/shipit`, archives the Release app from
a clean `main`, uploads it to App Store Connect, tags the commit
`ios-v<version>b<build>`, adds the build to the TestFlight groups with What
to Test notes, and submits it for Beta App Review. When
`ios/Config/Version.xcconfig` holds an App Store version, such as 1.0, it
first pushes the first TestFlight version, 1.0.1, to `main`. See
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
| `KeychainStorage` | `Session/KeychainStorage.swift` | The token's Keychain item: `SystemKeychain(accessGroup:)`, or `InMemoryKeychain` in package tests and fixture launches. The [hosted tests](#hosted-tests) check `SystemKeychain`. |
| `APIError` | `API/APIError.swift` | `kind`, the server's `message`, Better Auth's `code`, and the `requestID` the request sent. `isPermanent` says whether polling should stop, and `explanation(otherwise:)` words the failure for the member. |
| `APIRequestObserver` | `API/APIRequestObserver.swift` | Sees every finished request: route pattern, request ID, status, duration, and error. The app's observer is `Telemetry`; see [Sentry](#sentry). |
| Models | `Models/` | `Screens.swift`, `Feed.swift`, `Titles.swift`, `People.swift` (members and notifications), and `Results.swift` (other actions and `ErrorBody`). |
| `AppServices` | `AppServices.swift` | The client, session, pending invitation, identity providers, image session, avatars, and visit tracker together, injected with `.screenrServices(_:)`. |

- **Headers:** every request sends `Screenr-Client: ios/<version>/<build>`
  and a new `Screenr-Request-Id`, plus `Authorization: Bearer <token>` while
  signed in. It never sends cookies or an `Origin`. The screen read that
  marks a [visit](#visits) also sends `Screenr-Visit: 1`.
- **Session:** a sign-in request stores the token from `set-auth-token` in
  the Keychain, and `.signOut` removes it, as does a successful
  `.deleteAccount`. `SessionStore.ending` then says how the session ended,
  `.signedOut`, `.expired` when a 401 ended it, or `.accountDeleted`, until
  the next sign-in, and `onEnd(_:)` handlers receive it. A sign-in made
  `.confirming(userId:)` keeps its new token only when the response names
  that user; see [account deletion](#account-deletion). A 401 to a request
  that carried a token removes that token, unless a newer one replaced it.
  Linking a sign-in method and confirming the member are the exceptions:
  their requests' `unauthorized` is `.rejectsCredential`, so a 401 for the
  provider's token, such as `INVALID_TOKEN` or `OAUTH_LINK_ERROR`, is
  `.rejected(status: 401)` and keeps the session. Only Better Auth's
  `UNAUTHORIZED` code ends it.
- **Reinstalls:** iOS keeps the Keychain when the app is deleted, but not
  the app's own UserDefaults or its app group. Before the app's first log
  line, `InstallLaunch.record(defaults:appLog:)` reads and sets a mark in
  UserDefaults. A launch without the mark is the first since an install,
  unless the app group already holds the app's `app.ndjson` log, which
  every earlier build wrote at each launch, as after an update from a build
  before the mark. At that first launch, `AppServices` removes any session
  token a deleted install left, so the app starts signed out, then signs that
  session out on the server, which removes its push devices; offline, it
  ends when it expires. Fixture launches never read the Keychain, so UI
  tests are unaffected. `InstallLaunchTests` cover it.
- **Writes in the background:** `URLSessionTransport` runs every request
  but a GET inside a `BackgroundActivity`, which in the app and its
  extensions is `ProcessActivity`, iOS's expiring activity. So a write
  started before the member leaves the app or the share sheet keeps running
  until it answers, for as long as iOS allows, rather than failing after the
  server applied it. Reads repeat on return, so they ask for no time.
  `URLSessionTransportTests` cover it with a stand-in `URLProtocol`.
- **Text limits:** comment, post, and review drafts stop at 2,000 UTF-16
  code units, as the server counts with JavaScript's `length`, so most
  emoji count as two, through `String.prefix(utf16Limit:)`. A cut never
  splits a character.
- **Caching:** each GET's response is kept in memory with its ETag. Reading
  the same path again sends `If-None-Match`, and a 304 returns the cached
  value. The cache keeps the 32 most recently used reads, and at most 8 MB
  of their bodies, though always the newest, so notification links, each
  with its own query, never pile up copies of a long feed. Signing in or
  out, and iOS's memory warning, clear it.
- **Late responses:** a successful or unchanged response to a request that
  carried a token, arriving after that session ended or another replaced it,
  belongs to the earlier member. The client neither caches nor returns it
  and fails the request as `.cancelled`, which callers ignore. Requests that
  change the session, such as `.signOut`, still apply.
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
| `-ScreenrFixtureSession` | `signedIn` (default), `signedOut`, or `expired`: a saved session that gets `errors/signed-out` until the next sign-in. |
| `-ScreenrFixtureProfile` | `complete` (default), or `pending` for a viewer without a profile, such as `pat`: every action but those `rules/before-profile` lists, such as setup, gets `errors/incomplete-profile`, as on the server, until a setup request succeeds. |
| `-ScreenrFixtureOverride` | A fixture that answers first, such as `screen/feed/empty`. Repeatable. |
| `-ScreenrFixtureUpdate` | A fixture that answers before any other, overrides included, once the `-ScreenrFixtureUpdateSignal` file exists, such as `screen/feed/incoming`, so the app's next read, such as a poll, brings new activity. Repeatable. |
| `-ScreenrFixtureUpdateSignal` | The file whose creation sends the `-ScreenrFixtureUpdate` fixtures. |
| `-ScreenrFixtureFailure` | A fixture that answers every `/api/screenr` request, such as `errors/update-required`. |
| `-ScreenrFixtureOutageSignal` | A file whose existence fails every `/api/screenr` request with a 502 and no body, as from the proxy during a deploy, so the app's next reads, such as a poll, fail until the file is removed. |
| `-ScreenrFixtureHolds` | A directory where a file at a request's path holds the app's requests to that path, such as `api/screenr/photo` for a photo upload or `api/auth/link-social` for a link, until the file is removed, so a change stays in flight, such as through a failed read. A request the file releases then answers as any other. |
| `-ScreenrFixtureLog` | A file that gets a line per `/api/screenr` and `/api/auth` request, such as `GET /api/screenr/screen?path=%2F`, with ` visit` after the app's [visit](#visits) and a write's JSON body, keys sorted, after the write: `POST /api/screenr/read-notification {"id":"18"}`. An upload has its type and size instead: `POST /api/screenr/photo image/jpeg 41250 bytes`. Sent [feedback](#feedback) adds a `FEEDBACK` line. A [trailer](#trailers)'s player adds `WEB <url>` for each page it asks for. The [share extension](#share-extension) adds `SHARE completed` or `SHARE cancelled` as it ends each request. The [age check](#age-check) adds `AGE required` and, where the scenario's law requires it, `AGE range 18`. The app's launch starts the file empty; the share and [notification](#push-content) extensions add their requests to it. |
| `-ScreenrFixtureAge` | What the [age check](#age-check) finds: `notRequired` (default), where the law doesn't require it, or where it does, `adult`, `minor`, `declined`, or `failing`. |
| `-ScreenrFixturePush` | The notification permission the app finds: `undecided` (default), `allowed`, or `denied`; or `system` for iOS's own permission and APNs registration. See [push notifications](#push-notifications). |
| `-ScreenrOpenURL` | A link the app opens at launch, as if the system delivered it, such as `screenr-dev://titles/tv/201`. |
| `-ScreenrAppearance` | `dark` or `light`, in place of the system's appearance, which a Simulator changes for its apps only after it restarts. |
| `-ScreenrPushTap` | A notification ID the app opens at launch, as if the member had tapped its push, such as `18`. |
| `-ScreenrFixturePosters` | `placeholders` (default), so every poster shows its title's initial, or `solid` for a solid gray poster, from a data URL, for every poster path. |
| `-ScreenrAuditProbe` | `faintClippedText` shows one line of faint, cut-off text over every screen, which the accessibility audit must fail. |

In UI tests, `app.launch(with: FixtureLaunch(viewer: "nora"))` passes them,
with the directory found from the test's source path; `requestLog`, `link`,
`appearance`, `pushTap`, `push`, `posters`, and `auditProbe` pass
`-ScreenrFixtureLog`, `-ScreenrOpenURL`, `-ScreenrAppearance`,
`-ScreenrPushTap`, `-ScreenrFixturePush`, `-ScreenrFixturePosters`, and
`-ScreenrAuditProbe`; and
`update: FixtureUpdate("screen/feed/incoming")` passes the update arguments,
whose fixtures answer once the test calls `update.send()`; and
`outage: FixtureOutage()` passes the outage signal, which `outage.begin()`
creates and `outage.end()` removes; and `holds: FixtureHolds()` passes the
holds directory, where `holds.hold("/api/screenr/photo")` holds a path's
requests and `holds.release(_:)` lets them answer. The fixture API keeps the
session in memory.
A request gets the fixture with the same action and
query or body, then falls back to the screen's path or to a successful
fixture for the action, and otherwise gets the server's recorded 404,
`screen/not-found/default` or `errors/unknown-action`. Paged feed and profile
fixtures, whose path names a window, such as `screen/feed/newest-page` and
`screen/feed/older-page`, answer only as overrides, and a paged poll, whose
path names `since`, gets the fixture that last answered its path, as the
server keeps the window the app read. A matching ETag gets 304. Apart from setup, writes
change nothing, so later reads answer as before; a UI test checks what a
write sent in the request log.

Better Auth's routes answer with their recorded `auth/` fixtures: requesting
a code, signing in, which returns `FixtureTransport.token` in
`set-auth-token` and Alice as the user, linking, and signing out succeed,
and every invitation link is available, unless an `auth/` override answers
the route, such as `auth/email-otp/send-verification-otp/rate-limited`,
`auth/sign-out/failed`, or `auth/invitation/unavailable`. Apple and Google
sign-in and linking accept only the stub credentials described in
[Sign-in](#sign-in), and answer others with the route's `invalid-token`
fixture. Photos are not served, so avatars show initials.

## Age check

Screenr is for people 18 or older
([terms decision](../docs/product-brief.md#terms-of-use-and-adults-only--2026-11-09)).
Where the law requires apps to check the age category that Apple shares, as
in Texas, Utah, and Louisiana, the app checks it with Apple's
[Declared Age Range](https://developer.apple.com/documentation/declaredagerange)
API at each launch, before sign-in, and refuses anyone the category doesn't
show to be an adult. Elsewhere it never asks. The website has no such check,
since the laws cover App Store apps and the API is Apple's.

| Piece | Where | What it does |
| --- | --- | --- |
| `AgeCheck` | ScreenrKit `AgeCheck/` | `@Observable`, in the environment through `.screenrServices(_:)`. Its `phase` is `checking`, `allowed`, or `refused` with `minor`, `declined`, or `failed`. `check(using:)` checks once while the phase is `checking`, and `retry()` returns a refusal to `checking`. |
| `AgeAssurance`, `DeclaredAge` | ScreenrKit `AgeCheck/` | The service's two questions: whether the law requires the check, and the person's age range around a gate, `declined` or `shared(lowerBound:)`. |
| `SystemAgeAssurance` | `Screenr/Shell/` | Apple's service: `isEligibleForAgeFeatures`, then `requestAgeRange(ageGates: 18, in:)`, which shows Apple's sheet from the window's top view controller. SwiftUI's `requestAgeRange` action isn't `Sendable`, so Swift 6 can't call it from the main actor. |
| `AgeCheckView`, `AdultsOnlyView` | `Screenr/Shell/` | A spinner while the check runs, from when the app is first active, and the refusal, "Screenr is for adults". |
| `FixtureAgeAssurance` | ScreenrKit `FakeAPI/` | Fixture launches' stand-in, from `-ScreenrFixtureAge`, which writes each question to the request log. |

- **Whether to ask:** `isEligibleForAgeFeatures` alone decides, as Apple's
  [guide](https://developer.apple.com/documentation/declaredagerange/requesting-people-share-their-age-range-with-your-app)
  directs before requesting a range. The app doesn't read
  `requiredRegulatoryFeatures`, since refusing minors answers each feature it
  lists. In the iOS 27 Simulator on 2026-11-09, `isEligibleForAgeFeatures`
  was false, yet `requiredRegulatoryFeatures` listed all three features and
  `requestAgeRange` threw `notAvailable`, so taking that list as the law's
  requirement would refuse everyone there.
- **An adult:** a shared range whose lower bound is 18 or more, as Apple says
  to enforce a minimum age. Where the law requires the check, the system
  bounds the range by the law's categories, such as Texas's under 13, 13 to
  15, 16 to 17, and 18 or older, rather than by the app's gate.
- **Refused:** a range that starts below 18 or has no lower bound, a
  decline, and any error from either call, including from
  `isEligibleForAgeFeatures`, since then the app can't tell that the law
  doesn't apply. A minor gets no way in. A decline or a failure offers Try
  again, which checks again; the decline's message points to Settings → your
  name → Personal Information → Age Range for Apps, where a person changes
  what they share.
- **First:** the check comes before every screen that reads from the
  server, so a refused app reads nothing. Links that arrive during the check
  wait in the router, and an invitation link is checked with the server once
  the age check passes.
- **Each launch:** the check runs at every launch and on Try again, never on
  a return to the foreground. Apple caches each person's answer, so its sheet
  doesn't show every time.
- **Privacy:** the age stays in the check. The app never sends it to the
  server, stores it, or logs it; a failed check logs only the error's type
  and code, at notice level, which stays in the app's log file. The privacy
  policy says the app checks the age category on the iPhone.

`AgeCheckTests` in ScreenrKit cover the rules against a fake service, and the
UI tests' `AgeCheckTests` cover each screen against `FixtureAgeAssurance`:
the request log shows the app never asks for a range where the law doesn't
require it, and a refused app sends no request.

What the tests can't reach:

- **Apple's service where the law applies:** Apple's
  [age assurance sandbox](https://developer.apple.com/documentation/storekit/testing-age-assurance-in-sandbox)
  runs only on a device, and the Simulator's service never requires the
  check, so no test shows Apple's sheet or gets a real age range. What
  `SystemAgeAssurance` gets there rests on Apple's documentation.
  `LaunchTests.testLaunchShowsTheWordmark`, which launches without fixtures,
  does run it in the Simulator, where it lets the person in without asking.
- **Sessions from before a refusal:** the check gates the app's screens. The
  share extension, notification actions, and Siri and Shortcuts use the
  session the app saved and run no check, so one saved before a refusal,
  such as by a build without the check, still works there. A refused person
  never reaches sign-in, so they can't save a new one
  ([#623](https://github.com/jubishop/screenr/issues/623)).

## Sign-in

The signed-out screen, `Screenr/SignIn/SignInView.swift`, offers Sign in
with Apple, Google, and an email code
([decision](../docs/ios-app.md#email-code-sign-in-with-apple-and-google--2026-10-13)).
Those controls are `SignInControls`, which
[account deletion](#account-deletion) reuses to confirm it's the member.
Their behavior lives in ScreenrKit's `SignIn/` folder:

| Piece | What it does |
| --- | --- |
| `SignInModel` | The screen's `@Observable` model. The email code takes two steps, and the second offers a new code. It shows the server's messages, such as the code limits and a [suspended member's](../docs/data-and-access.md#member-suspension) refusal, as the server words them, even while confirming the member. |
| `PendingInvitation` | The token of the invitation link a new member opened, which every sign-in request sends as `Screenr-Invitation`. See [invitations and setup](#invitations-and-setup). |
| `InvitationPickup` | Before a person without an invitation first signs in, asks Safari for the one an invitation link saved there before the app was installed. See [invitations and setup](#invitations-and-setup). |
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
user there. A read that the ended session started reports nothing to
`ShellModel` when it answers. A session that an extension ended runs no
handler in the app, so a launch without a session also empties the image
cache, clears the badge and Notification Center, and removes the Spotlight
titles. Posters and profile photos load through `AppServices.imageSession`,
which `.screenrServices(_:)` sets as the `AsyncImage` session, with requests
from `AppServices.images`, an `ImageSource`; see [Conversations](#conversations).
Avatars decode profile photos through `AppServices.avatars`, an
`AvatarImages`, which loads them through the same session and decodes each
at the avatar's size with ImageIO. It keeps up to 8 MB of decoded photos,
which it forgets when the session ends or iOS warns that memory is low.

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
Google account, so tests use the fixture API's stand-ins, and the real
services rest on Apple's and Google's documented behavior.

## App shell

The shell is the structure every feature screen plugs into. It follows the
session, shows the tabs, maps links to destinations, keeps the visible
screen current, and provides the shared controls.

```text
ScreenrApp            builds AppServices and ShellModel, opens -ScreenrOpenURL
└─ AppRootView        follows AgeCheck.phase, handles onOpenURL
   ├─ AgeCheckView              .checking (the age check)
   ├─ AdultsOnlyView            .refused
   └─ allowed, by SessionStore.phase
      ├─ RequiredUpdateView     .updateRequired (a 426)
      ├─ SignInView             .signedOut (SignIn/)
      └─ signed in, by ShellModel.account
         ├─ SetupView           .needsSetup (a 403 on the feed; Screens/)
         └─ MainTabView         .ready
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
When the server ended it, such as after it expired, the last link `open(_:)`
showed opens again for the next sign-in if its screen had not loaded yet,
since the member may have followed it into the 401. Signing out and deleting
the account forget it. [Settings](#settings) ends with `SignOutButton`.

| Piece | Where | What it does |
| --- | --- | --- |
| `Destination` | ScreenrKit `Navigation/` | One case per member route, plus `join` and `notFound`. `Destination(path:)` and `path` match the web's member routes, as the [shared cases](#shared-cases) check, `Destination(url:)` reads universal links and `screenr-dev://` links, `shareURL` builds a screenr.club link, and `pageName(for:)` names the page. |
| `Router` | ScreenrKit `Navigation/` | `@Observable`: the selected tab, each tab's stack, and the sheet. `open(_:)` takes links from outside the app, and puts an invitation link's token in `PendingInvitation`. The last link waits until `screenLoaded(_:)` reports the screen that shows it, so `sessionEnded(_:)` can keep it across an expired session. |
| `ShellModel` | ScreenrKit `Shell/` | `@Observable`: the account check, the viewer, the bell's unread count, the app's activity, `screenModel(for:)`, `pushArrived()`, `refreshLiveReads()`, and `onUnreadCount(_:)`, which reports each unread count, such as for the app icon's badge. Views read it with `@Environment(ShellModel.self)`. |
| `LiveRead`, `ScreenModel` | ScreenrKit `Shell/` | A GET request's `phase` (`loading`, `loaded`, or `failed`) and its polling. `ScreenModel` is `LiveRead<Screen>`; other live reads, such as the notifications sheet's, use `LiveRead(.notifications(), api:)`. |
| `DestinationView` | `Screenr/Shell/` | Maps each destination to its screen, owns its `ScreenModel`, and adds polling, the navigation title, and redirects. |
| `ScreenContent`, `MessageView` | `Screenr/Shell/` | Render a model's phase: a spinner, the error with Try again, or the loaded screen, in one container that stays the screen's root as the phase changes; and a full-screen message. |
| `.livePolling(_:)` | `Screenr/Shell/` | Connects any `LiveRead` to its view's visibility, the app's activity, pull-to-refresh, and pushes. |
| `IncomingActivityButton` | `Screenr/Shell/` | The New activity control; `.incomingActivity(_:count:show:)` floats it over a screen, and only the control animates. `show` must keep the reader's place, as `FeedList` does. The control's identifier is `incoming-activity`; `performShellAudit()` treats its glass like a bar's, so a test checks its label with `labelContrast()`. |
| `ShareButton` | `Screenr/Shell/` | A `ShareLink` for a destination's screenr.club link. |
| `.keyboardSafeSheet(item:content:)` | `Screenr/Shared/` | Presents every sheet in the app. It ends text editing before the sheet opens, so UIKit has no keyboard to bring back as the sheet closes; see the [keyboard deadlock](#toolchain-notes). |
| `.keyboardSafeNavigation(_:)` | `Screenr/Shared/` | Ends text editing whenever a tab's navigation path shows a new screen, before the transition starts, whether a link or `Router` changed it, so a later pop has no keyboard to bring back; see the [keyboard deadlock](#toolchain-notes). |
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
| `/people/<viewer>/want-to-watch`, with or without `?mode=theaters` | Pushed on You. |
| `/invites`, `/watch-together` | Pushed on Friends. |
| `/account` | Settings over You. |
| `/titles/…`, `/people/<other>`, `/people/<other>/want-to-watch`, `/conversations/…`, unknown paths | Pushed on the current tab. A conversation shows the entry it redirects to in its place. |
| `/join/<token>` | Keeps the token in `PendingInvitation` for sign-in and setup, checks it with the server, and opens Circle's root. A member who has a profile lands there, as on the web, unless a later link took its place, and the app forgets the token. |

A profile or Want to watch link that arrives before a screen names the
viewer, such as at launch or after the session expired, waits in the router
and opens by these rules once one does, so the viewer's own pages still open
in You. A later link takes its place, and signing out forgets it.

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
already in flight, which may have started before a write or the push. A
read that answers after its screen stopped never applies. Each read gives up
after ten seconds. A failed read replaces the content with the
error; passing failures keep polling, and a permanent error stops it until a
read succeeds. An unchanged screen keeps its `phase`, so nothing renders
again, and the model's `onLoad` hears it was `.unchanged`: the shell then
passes on only its unread count, for the badge, and that a link to it
arrived, and skips the rest, such as Spotlight's scan of the screen. Each
read after the three-second wait is a poll, sent as
`RequestTrigger.poll`, which [Telemetry](#sentry) records quietly when it
succeeds; every other read is `.demand`. `ScreenModel.change(path:)` reads a
new path from then on, such as Find a title's with changed
[filters](#find-a-title): at once while the screen is live, replacing the
read in flight, and keeping the screen shown until the new read answers. A
read's value can also move later reads to another request through
`LiveRead`'s `follow`, as a paged screen's window does, and `read(_:)` reads
a new request now and waits for it, as Show older does. `ScreenModelTests`
cover the timing with a `TestClock`.

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
   in the view model or in state outside `ScreenContent`, and attach sheets
   and confirmation dialogs outside it too, or the failure closes them.
   `ScreenContent` keeps one container as the screen's root through every
   phase: in the iOS 27 Simulator, when the root itself changed with the
   phase, a confirmation dialog attached outside stayed on screen through a
   failed read, but SwiftUI reset its binding and its buttons did nothing. A
   prompt that a later read can make stale takes each read through its
   model's `reconcile(with:)`, as `TitlePageModel` and `ProfileModel` do.
3. **Navigation:** push with `NavigationLink(value: Destination.title(id:))`;
   the tab's stack shows it. Use `shell.router.open(_:)` only for links from
   outside the current screen, such as a notification.
4. **Shared controls:** share with `ShareButton(destination:subject:)`. For
   other people's incoming activity, build on the feed's: `FeedModel` keeps
   an `AcceptedActivity`, `FeedLayout` counts what waits in `incoming`, and
   `FeedList` floats `.incomingActivity(.activity, count: layout.incoming)`
   over the screen, as [Conversations](#conversations) describes.
5. **Tests:** test the view model with `swift test`, against `ScriptedAPI` and
   `TestClock` in `Tests/ScreenrKitTests/Support/` or against
   `FixtureTransport`. Write UI journeys with
   `app.launch(with: FixtureLaunch(link: "screenr-dev://titles/tv/201"))`,
   choosing fixtures with `viewer` and `overrides`, and audit screens in the
   tabs with `app.performShellAudit()`. Every audit checks only contrast,
   Dynamic Type, clipped text, and hit regions: `performSettledAudit` uses
   `XCUIAccessibilityAuditType.screenr` by default, and a direct audit calls
   `performScreenrAudit()`. Both audit one check at a time: in the iOS 27
   Simulator, while another Simulator ran UI tests, an audit of all four
   sometimes never finished ("Audit failed to complete in time"), even at a
   modest load, and its retry then failed the same way. Hit regions and
   contrast go first, then clipped text, which can scroll a scroll view to
   bring cut-off text into view, then Dynamic Type, which can scroll a list.
   On a title page scrolled by hand, a contrast check right after the
   clipped-text check's scroll never finished, at any load, and the
   Simulator's `testmanagerd` kept using several cores until the Simulator
   shut down.
   `performShellAudit()` passes over
   what the audit cannot measure in a scrolling screen, as
   [Conversations](#conversations) describes. While a list row or control
   reaches beneath a bar or the keyboard or past the screen's edge, it also
   passes over contrast and clipping issues without an element, which are in
   parts of a row without an element of their own or in text cut off at that
   edge, such as the next poster in a row that scrolls sideways. In a screen
   that scrolls, it passes over Dynamic Type issues without an element too.
   While Find's search field holds text, and only then, the clipped-text
   check also reports one issue without an element at every text size,
   though nothing in the app's content clips: the field's text. The shell
   audit passes over that one issue; a second, one with an element, or one
   while the field is empty still fails.
   `FindTests.testAuditStillFailsFaintAndClippedTextWhileSearching` launches
   with `FixtureLaunch(auditProbe: .faintClippedText)` and checks that the
   shell audit still fails faint and cut-off text on Find's results.
   `ShellTests`
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
  changes. The confirmation sits outside the read's content, so a failed
  read beneath leaves it open, and `reconcile()` closes it once the page no
  longer offers the request an answer.
- **Counts:** after each action, `shell.refreshLiveReads()` makes the screen
  beneath read again, so every screen's unread count, and the bell's, catch
  up.

One action runs at a time. A failed one shows an alert with the server's
message, and the page reads again. Closing the sheet leaves the screen
beneath and its state, such as an unsent draft, untouched. The keyboard
stays down until the reader taps the draft's field again, as for every
sheet that `.keyboardSafeSheet(item:content:)` presents.

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
  `PushTarget` that `AppConfiguration.pushTarget(infoDictionary:)` reads. A failed registration tries again on the next return.
  While notifications are off in iOS Settings, the app still asks APNs for
  the token, which APNs issues regardless of the permission, and removes the
  device with `push-device` once per launch, since an earlier launch in the
  session may have registered it. A failed removal tries again on the next
  return. Signing out ends the
  session, and the server deletes the session's devices with it; the app
  clears Notification Center and the badge, as it does on a launch without
  a session, and the next member registers the device again.
- **Environment:** `SCREENR_APS_ENVIRONMENT` in `Dev.xcconfig` and
  `Release.xcconfig` sets both the `aps-environment` entitlement and the
  `ScreenrAPSEnvironment` Info.plist key, so a token always names the APNs
  environment that issued it: `development` (`sandbox`) for Screenr Dev,
  which runs in the Simulator, and `production` for the Release builds that
  TestFlight and the App Store install. The topic is the bundle ID. Only the
  app reads them: the extensions register no device, so their
  `AppServices.push` is nil.
- **Categories:** at launch, `AppDelegate` registers
  `PushCategory.notificationCategories`: `FRIEND_REQUEST` and `COMMENT`, the
  categories the worker names, with the
  [actions](../docs/ios-app.md#notification-actions--2026-10-13) that
  `PushCategory.actions` lists. `FRIEND_REQUEST` offers Accept and Decline,
  and `COMMENT` a Reply text field whose button is Post. Each
  `PushAction.Identifier` builds its `UNNotificationAction`: none opens the
  app, each needs the passcode or Face ID on a locked phone because it
  changes what friends see, and Decline is destructive.
- **Taps:** `PushTap(userInfo:)` reads the payload's `notificationId`, and
  `open(_:)` reads that notification with `GET /api/screenr/notification`.
  It opens the notification's `href` with `shell.router.open(_:)`, as the
  bell does, then sends `read-notification` and refreshes the live screens.
  A notification the member can no longer see, a payload without an ID, or
  a failed read opens the bell instead; while signed out or with a required
  update, a tap does nothing. A tap that launches the app works the same
  way: the router keeps the destination until the tabs show.
- **Actions:** `AppDelegate`'s `userNotificationCenter(_:didReceive:)`
  reads any other identifier as a `PushAction`, with a Reply's
  `UNTextInputNotificationResponse.userText`, and awaits
  `perform(_:notificationID:)`, because iOS suspends a background app,
  including one it launched for the action, once the method returns. Accept
  and Decline send `respond-friend-request`, which also marks the
  notification read. Reply reads the notification with
  `GET /api/screenr/notification`, posts `comment` with its `thread` as the
  `conversation` and its `comment` as `replyTo`, never as a spoiler, then
  sends `read-notification`. After a successful action the live screens
  read again; nothing opens. A blank reply, a hidden notification, a
  request no longer pending (404), or a signed-out session stops the action
  with an info log line; any other failure logs a `Log.push` warning, which
  reaches Sentry, and a reply that fails leaves the notification unread in
  the bell. The worker's badge-only updates then correct the app icon.
- **Failed actions:** an action that fails with a warning, or a reply over
  2,000 UTF-16 code units after trimming, which is never sent, posts a
  `FailedActionAlert` through `PushSystem.post(_:)` in its place: "Your
  reply wasn’t posted", or "The friend request wasn’t accepted" or
  "…declined", with why. Its payload names the notification, so tapping it
  opens the notification as tapping the push does. A reply's alert also
  carries its text as `unpostedReply`; the tap keeps it in
  `ShellModel.keepReply(_:for:)` for the reply composer beneath the
  notification's comment, and the first `FeedList` that shows the entry
  opens that composer with the text as its draft, through
  `FeedModel.restoreReplies(from:in:viewer:)`. Ending the session forgets
  kept replies.
- **While open:** a push that arrives while the app is open shows its
  banner, sound, and badge as usual, and calls `shell.pushArrived()`, so the
  visible screen reads again.
- **Badge:** `ShellModel.onUnreadCount` reports every unread count the app
  reads, and `PushNotifications` sets the app icon's badge to it with
  `setBadgeCount`, skipping repeats except for the first count after each
  return to the foreground. When the session ends, the badge goes to 0. The
  worker's [badge-only updates](../docs/notifications.md#badge-only-updates)
  keep it current while the app is closed.

### Push content

`ScreenrNotificationService`, which the app embeds, turns each alert's
generic "New activity on Screenr" into a Communication Notification from the
notification's actor before iOS shows it
([decision](../docs/ios-app.md#the-extension-fetches-push-content--2026-10-13),
[what each kind shows](../docs/notifications.md#push-delivery)):

1. **Reading:** `PushTap(userInfo:)` reads the payload's `notificationId`,
   and `PushContentLoader` reads that notification with
   `GET /api/screenr/notification`. iOS may show several pushes in one
   process, which share one `AppServices(…, host: .notificationExtension)`
   through `ExtensionServices`, so later pushes reuse its connections. A
   push whose Keychain token differs from the one those services read,
   after the member signed in again or out in the app, gets new services,
   and the old ones close once no push uses them.
2. **Wording:** `PushContent` holds the sender and the body. iOS shows a
   direct message's sender in place of the alert's title and subtitle, so
   the body leads with the action, such as "Replied to your comment about
   Harbor Lights: Did you see the end?". A spoiler's body ends "Contains
   spoilers." even if an excerpt arrives with it.
3. **Avatar:** `PushAvatars.network(images:session:)` loads the actor's
   `/api/photos/<actorId>/<actorPhoto>` with the bearer token, as
   `ImageSource` requests every photo. Without a photo, iOS shows the app
   icon.
4. **Showing:** `PushContent.notificationContent(updating:avatar:)` puts the
   sender's name and the body on the payload's content, donates an incoming
   `INSendMessageIntent` from the actor, and returns the content that
   `updating(from:)` makes of it. The category, thread, and notification ID
   stay, so taps, actions, and grouping work as before. If iOS refuses the
   intent, the alert still shows the text.
5. **Falling back:** the loader delivers once. A payload without an ID, a
   hidden notification, a failed read, or services that cannot start, such
   as with the Keychain locked after a restart, keep the generic alert. When
   iOS calls `serviceExtensionTimeWillExpire`, about 30 seconds in, the
   loader delivers the best alert so far: the generic one while the read is
   out, or the rich one without its avatar while the photo loads.

| Piece | Where | What it does |
| --- | --- | --- |
| `NotificationService` | `ScreenrNotificationService/` | The principal class. iOS calls it from threads of its own, so the target's code is nonisolated by default. It hands iOS's content handler to a `PushContentLoader`, logs to `notifications.ndjson` in the app group's log directory with `Telemetry.localOnly()`, and starts no Sentry. Screenr Dev's extension answers from the app's fixtures through `FixtureHandoff`. |
| `PushContent`, `PushContentLoader`, `PushAvatars` | ScreenrKit `Push/` | The wording, the read and its fallbacks, and the photo. |
| `CommunicationNotification.swift` | ScreenrKit `Push/` | The message intent and the content iOS shows. It builds only for iOS, which alone has the intent. |

- **Capability:** the app's entitlements hold
  `com.apple.developer.usernotifications.communication`, and its
  `Info.plist` lists `INSendMessageIntent` in `NSUserActivityTypes`. The
  extension's `Info.plist` lists it in `IntentsSupported`, and its
  entitlements hold only the app group.
- **Signing:** the bundle ID is the app's with `.NotificationService`. See
  [Apple Developer](../docs/running-screenr.md#apple-developer).
- **Simulator:** `xcrun simctl push` skips service extensions, so its alert
  stays generic. A real APNs sandbox push reaches the Simulator, and the
  extension runs: launch Screenr Dev with `-ScreenrFixtures`,
  `-ScreenrFixturePush system`, and `-ScreenrFixtureLog`, allow
  notifications, and send the worker's payload to the device token from the
  log's `push-device` line, signed with the APNs key, as `src/server/apns.ts`
  does. The fixture API loads no photos, so the avatar is the app icon.

### Push tests

`PushNotificationsTests` and `PushSettingsModelTests` cover the behavior with
`RecordingPushSystem` and `RecordingAPI`. Fixture launches use
`FixturePushSystem` instead of iOS, so most UI tests never meet the
permission prompt: `-ScreenrFixturePush` sets the permission the app finds, a
member who has not decided allows notifications when asked, and no device
token arrives, so nothing registers. `PushNotificationsTests` also cover each
action's requests and the categories' actions.

The server's tests record what the worker sends APNs in `Fixtures/push/`:
an alert for each kind of notification, with its category and thread, and
a badge-only update. `PushPayloadTests` check that each alert is mutable and
names the notification its `actions/notification/` fixture reads, and that
the alerts use the categories the app registers.

`PushTests` deliver those pushes to the app delegate through `PushRelay`:
the test writes the payload to the folder bin/check-ios names in
`SCREENR_PUSH_RELAY`, and the check sends it with `xcrun simctl push` while
the test waits; run outside the check, these tests skip. The app launches
with `FixtureLaunch(push: .system)` and allows notifications at iOS's prompt
when the bell first opens. On a new Simulator under load the prompt can take
over half a minute to come up, so the run's first test keeps the bell's sheet
open until Springboard shows it, for up to two minutes. Tapping the banner
opens the item, and pressing and holding it offers Accept and Decline on a
friend request and the Reply field on a comment, whose requests the request
log shows. A tap that launches the app follows `FixtureLaunch(pushTap: "18")`,
which passes `-ScreenrPushTap`.

`PushContentTests`, `PushContentLoaderTests`, and `NotificationServicesTests`
cover [push content](#push-content) from the single-notification fixtures:
each kind's wording, spoilers, the avatar, and the generic alert after a
hidden notification, a failed read, and time running out. A
`PhotoRequests` fake holds a photo until its task is cancelled, and
`ScriptedAPI`'s `.hang` holds the read. `CommunicationNotificationTests`
check the message intent and run only in the Simulator. iOS runs the
extension only for an APNs push, which `simctl push` is not, so
`NotificationServiceTests`, a [hosted test](#hosted-tests), hands the
recorded pushes to the extension's `NotificationService` itself, compiled
into the test target, and checks the alert it delivers.

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

The alert stays generic, since `simctl push` skips the
[notification extension](#push-content). Tapping the notification opens
Harbor Lights at Ben's reply. Pressing and holding it opens its Reply field
instead, since Reply is its only action; Post sends `notification`,
`comment`, and `read-notification`. For Accept and Decline, send the same
payload with `"category": "FRIEND_REQUEST"`, `"notificationId": "14"`, and
no `thread-id`. Leave Screenr Dev in the background rather than quitting
it: an app that iOS launches for an action gets no launch arguments, so it
would use the local server instead of the fixtures. The fixture request
log, from `-ScreenrFixtureLog`, shows the registration and the requests of
each tap and action.

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

### Invitation pickup

On an iPhone without the app, an invitation link saves the invitation in
Safari and goes to install the app
([decision](../docs/ios-app.md#invitation-links-install-the-app-on-iphone--2026-11-07)).
`InvitationPickup` brings it into the app:

- **When:** `SignInModel` runs it as a sign-in starts, while no invitation
  waits: before requesting a code, before Google's page, and after Apple's
  sheet but before posting its credential. It runs once a launch, and never
  once a member has signed in on this iPhone. `memberSignedIn()` records that
  in the Keychain item `SystemKeychain.member(accessGroup:)`, which outlives
  the app; a sign-in, a launch with a session, and a session a deleted
  install left all set it.
- **How:** `SignInView` passes SwiftUI's web authentication session as the
  model's `browser`. It opens `https://screenr.club/api/invitation-pickup`
  with the https callback `/api/invitation-pickup/done` on the same host, and
  shares Safari's cookies
  ([invitation pickup](../docs/data-and-access.md#invitation-pickup)). A token
  in the callback goes to `PendingInvitation.open(_:)`, exactly as a tapped
  link's does, so the screen says "You’re invited" and the sign-in sends it.
- **Fallback:** when the callback has no token, the person declines iOS's
  prompt, or the session fails, the phase is `missed` and the screen says
  "Screenr couldn’t find your invitation. If you’re new, tap your invitation
  link again to open it here." The sign-in goes on either way, since an
  existing member on a new iPhone needs no invitation.
- **Where:** only the Release app, whose bundle the site names for its web
  credentials (`webcredentials:screenr.club` in `Config/Screenr.entitlements`).
  Screenr Dev against a server never runs it. Against the fixture API,
  `-ScreenrFixturePickup found|missing|declined` sets what
  `FixtureInvitationPickup` answers; without it there is no pickup.

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
a change, `open(_:)` for an editor sheet, and the screen's `SettingsModels`:
the models of the sections that act in place rather than in a sheet, from
Profile photo to Sign out. Its behavior lives in ScreenrKit's `Settings/`,
`Photos/`, `Invitations/`, and `Feedback/` view models.

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
| Sign out | `SignOutModel` | `SignOutButton`, with the screen's `signOutFailure(_:)` alert when the server does not confirm it. |
| Delete account | `AccountDeletionModel` | A sheet that confirms it's the member with a new sign-in, then deletes the account after a confirmation; see [account deletion](#account-deletion). |

A new setting adds its section to `AccountView`'s list in one line, such as
`PushSettingsSection(settings)`; Delete account stays last. A section that
edits a draft opens its editor with
`settings.open(_:)` after adding a case to `SettingsEditor`, and a section
that acts in place keeps its model in `SettingsModels`. `AccountView`
keeps those models and presents those sheets and the sign-out failure alert
outside `ScreenContent`, so a failed read, which replaces the sections with
the error, keeps an open draft or alert, a change still saving, such as a
photo upload or a link, and the last change's failure or confirmation, as on
the web. Setup shows `SignOutButton` too and presents the same alert; no
read replaces its content.

Section headings use `SectionHeading`, and a setting's value `SettingRow`,
which keep the primary color: the system's gray falls short of the contrast
that text needs. Footers, through `SettingsFooter` or their own text, use
`.muted` for the same reason, and a destructive action on a bordered button,
such as Remove photo, uses `.danger`, since the system's red falls short of
4.5:1 on the button's gray fill.

`SettingsTests` cover the journeys: changing the name and username, uploading
and removing a photo, creating and revoking an invitation, revoking through a
failed read beneath the confirmation, which `FixtureOutage` causes, turning on
notifications and changing a push setting, connecting Sign in with Apple,
sending feedback, signing out, and a failed sign-out whose alert stays up
through a failed read beneath it. Through a failed read beneath them, a
push setting's and a link's failures stay, and a photo upload, an activity
email change, and a link that `FixtureHolds` keeps in flight still show as
saving, then show how they ended. They check what each write sent in the
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
  location, and decodes its 512-pixel preview once, so typing never decodes
  the screenshots again. Send needs a message. A swipe cannot close the sheet while it
  holds a draft, and once the feedback is sent the sheet thanks the member.
- **Length:** Sentry discards feedback whose message is over 4,096 Unicode
  code points: ingestion rejects it, and sentry-cocoa drops it before
  sending without telling the app. Following Sentry's
  [client-side validation](https://develop.sentry.dev/sdk/telemetry/feedbacks/#client-side-input-validation),
  `FeedbackModel.messageLength` counts the trimmed message that Send would
  send in Unicode scalars, which match code points: a decomposed é counts as
  two and an emoji as one. From 3,687, 90% of the limit, the form shows a
  live `X / 4096` count. Over 4,096 it also shows "Shorten your message to
  4,096 characters or fewer." and Send stays off. The form never cuts or
  blocks what the member types or pastes, so they choose what to shorten.
  The count and the error sit in a strip below the form, a `FormNoteBar`
  through `safeAreaInset`, above the keyboard while it's up: a section
  footer would fall below a long message, out of view. Capping the field's
  lines instead left a tall blank row beneath it once the member edited a
  long message.
  Relay also trims the feedback context to 8,192 bytes, but it measures the
  message, the context's first field, in code points against that budget,
  so it never trims a message within the limit. A long message of
  multibyte characters can cost only the fields after it, for Screenr just
  `source`.
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
  and the release and dist. They also cover the length limit at 4,096 and
  4,097 scalars. No test sends feedback to Sentry.
  `SettingsTests.testSendsFeedback` sends feedback against the fixture API,
  and `testKeepsFeedbackOverTheLengthLimit` pastes past the limit to reach
  the count and the error. It pastes through the field's edit menu, after
  setting `UIPasteboard`: Command-V from `typeKey` pasted nothing, and once
  the field held the pasted text, typing, deleting, and a long press for the
  menu all failed to reach it on the iOS 27 Simulator.

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
   the other account's new session out. A rejected Apple or Google
   sign-in, such as an account that isn't connected or an ID token that
   fails verification, also keeps the session.
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
//   FeedModel(api: api, refresh: { await model.refresh() },
//     showOlder: { await model.showOlder() })
//   ConversationStarter(subject: .title(id: id, kind: kind), api: api) { … }
// The inner view keeps them in State, outside ScreenContent, and presents the
// feed's confirmation there, so drafts, the reader's place, and an open
// confirmation outlive a failed read.
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
.feedConfirmation(feed)
```

| Piece | Where | What it does |
| --- | --- | --- |
| `FeedList` | `Screenr/Conversation/` | The scrolling feed beneath a header: entries in visible-activity order, New activity, the permalink's scroll and highlight, "This activity is unavailable.", and the empty message. Its screen attaches the feed's confirmation dialog, `feedConfirmation(_:)`, outside `ScreenContent`. `style: .compact` drops the poster, title, Want to watch, and Recommend for title pages. Changing `headerRequests` scrolls back to the header, such as when Start a conversation opens. Its `ScrollPosition` keeps the reader's place; see Reading place below. |
| `FeedAnchor` | ScreenrKit `Conversation/` | What the feed's scroll position names just before New activity shows: what it already names, the first entry before the reader scrolls, or nothing beneath a header that fills the screen. |
| `EntryView`, `ThreadView`, `CommentView` | `Screenr/Conversation/` | An entry, its discussion, and one comment, following the web's `feed.tsx` and `thread.tsx`. Each entry and comment carries the accessibility identifier `entry-<id>` or `comment-<id>`. |
| `CommentComposer`, `DiscussionComposer`, `StartConversationComposer` | `Screenr/Conversation/` | The one composer form, bound to a reply or comment target, or to a `ConversationStarter` with Season and Episode pickers on a TV title. Its field takes focus as it opens, and not again when its screen reappears; see the [keyboard deadlock](#toolchain-notes). |
| `ReactionControls`, `ReactionPicker`, `FeedActionStyle`, `WriteFailure` | `Screenr/Conversation/` | Reaction counts and React, which opens the seven reactions beneath its line, as on the web (a SwiftUI `Menu` label does not follow Dynamic Type); the compact actions with 44-point hit areas; and a failed write's message beneath its control. |
| `Avatar`, `PosterImage`, `FlowLayout`, `.muted`, `.danger`, `.onAccent` | `Screenr/Shared/` | A member's photo, decoded at the avatar's size, or initial on the web's colors; a TMDB poster, or the title's initial only while no poster shows, so an audit never measures an initial beneath a poster; a row that wraps; and text colors that keep 4.5:1 contrast, which the system's secondary label and red miss at small sizes, and the system's white misses on the dark theme's lime accent. |
| `.buttonStyle(.accent)` | `Screenr/Shared/AccentButtonStyle.swift` | The prominent accent-filled button, such as Accept, Send sign-in code, or Join Screenr, with its label in `.onAccent`. Use it in place of `.borderedProminent`. |
| `FeedModel` | ScreenrKit `Conversation/` | `@Observable` page state: accepted activity (`layout(_:viewer:)`, `receive`, `showIncoming`, and `show(entry:in:viewer:)` for a title page's friend line), Show older (`showOlder(_:)`, through its `showOlder` closure), revealed spoilers, each discussion's preview and groups, composers and their drafts, with replies a notification's Reply did not post (`restoreReplies(from:in:viewer:)`), reactions, removals through `confirmation`, and Want to watch and Recommend with the top 10 confirmations. Every write reads the screen again through its `refresh` closure. Its `reports` is the screen's [`ReportModel`](#reports). |
| `HistoryWindow`, `HistoryPage` | ScreenrKit `Conversation/` | A paged friends feed's or profile's window in its screen path (`before=now`, `since=<time>`, or `before=<time>`), and what a paged read sent besides its entries: `since` and `older`, as `screen.historyPage`. |
| `FeedLayout`, `ThreadLayout` | ScreenrKit `Conversation/` | The web's rules as values: which entries and replies show, their order, the New activity count, the three-comment preview, Show earlier comments, and nested groups. `SharedFeedLayoutTests` runs `FeedLayout` on the [shared cases](#shared-cases) that the web's layout runs too. |
| `ConversationStarter` | ScreenrKit `Conversation/` | Start a conversation: `.post` on the friends feed, or `.title(id:kind:)`, which loads a TV show's seasons and each chosen season's episodes. |
| Presentation | ScreenrKit `EntryPresentation.swift` | `item.action(style:)`, `item.title`, `discussionLabel`, `removedLabel`, `link(reply:)`, `RelativeTime`, `ReviewStars`, `ReactionKind.options`, and `TopTenLeaving`. |
| `ImageSource` | ScreenrKit | `@Environment(\.imageSource)`: TMDB poster requests, and profile photo requests with the bearer token. Against the fixture API it loads nothing, so UI tests show placeholders, unless `FixtureLaunch(posters: .solid)` (`-ScreenrFixturePosters solid`) asks for a solid gray poster from a data URL for every poster path. |

- **Incoming activity:** other people's new entries, moved entries, and new
  replies wait behind the shell's New activity control in all three feeds,
  as on the web, whose feeds use it for replies too. The reader's own
  entries and replies show at once, with the parents their replies need.
  Removals, withdrawn actions, and spoiler flags apply at once.
- **Reading place:** New activity keeps the entry at the top of the screen
  where it is, as the web's `preservePosition` does, and the activity
  arrives around it. Entries are the only scroll targets, so once the reader
  scrolls, or a link or a title page's friend line scrolls the feed, the
  scroll position names that entry, or the linked reply, and SwiftUI keeps it
  still. Before the reader scrolls, the position names nothing, so
  `FeedAnchor` names the first entry when it starts the screen; a header at
  the top, such as an open composer or a title page's details, stays put on
  its own, with new entries beneath it. `FeedTests` checks the second entry
  stays put, against `screen/feed/incoming`, which `FixtureUpdate` sends.
- **Paged histories:** the friends feed and profiles read a page of their
  history at a time, as on the web
  ([paged histories](../docs/title-feed.md#paged-histories)).
  `ShellModel.screenModel(for:)` makes their `ScreenModel` with
  `paged: true`, so the first read asks for the newest page, `before=now`,
  and each read moves later ones to the window it names, `since=<time>`.
  Beneath the entries, `FeedList(history: screen.historyPage)` shows Show
  older while older entries remain; it calls `FeedModel.showOlder(_:)`,
  which reads the window extended by the page before it through
  `ScreenModel.showOlder()`, and shows the entries that read adds at once,
  without New activity. A history without entries names no window, so
  polls read the newest page again. `FeedTests` shows Show older
  against `screen/feed/newest-page` and `screen/feed/older-page`.
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
  "2h" in the list.
- **Tests:** `ScreenrUITests/FeedQueries.swift` adds `app.entry(_:)`,
  `app.comment(_:)`, `app.composerField(_:)`, `app.scrollTo(_:)`, and
  `RequestLog.wrote(_:_:)`, which waits for a write's logged JSON body and a
  read after it. `performShellAudit()` passes over what the audit cannot
  measure in a scrolling screen: text beneath the glass bars, the floating
  New activity control, or the keyboard, or past the screen's edges, and
  Dynamic Type for scrolling content, which larger text moves past the
  screen's ends. To check large
  text, launch with
  `FixtureLaunch(textSize: "UICTContentSizeCategoryAccessibilityXXXL")` and
  audit there, as `FeedTests` does. Audit a composer after typing, once the
  keyboard has settled. ScreenrKit's `Support/FeedSupport.swift` has
  `FeedFixtures.entry(_:changing:)` for entries with changed fields and
  `RecordingAPI` for scripted writes.

### Reports

Members report another member's post, standalone title comment, review,
reply, or profile for Screenr's owner to review, as on the web
([decision](../docs/product-brief.md#reports-review-and-suspension--2026-11-09)).
The friends feed, title pages, and profiles present the form, and the offer
that follows it, with `.reporting(feed.reports)` outside their content, as
they do the feed's confirmation, so a failed read beneath leaves them open.

| Piece | Where | What it does |
| --- | --- | --- |
| `ReportSubject`, `ReportReason`, `ReportedContent` | ScreenrKit `Reports/` | What a place offers to report, and whose it is: `ReportSubject(entry:viewer:)` for another member's active post, standalone title comment, or review, or the review in their card, by the review's own ID; `ReportSubject(reply:in:viewer:)` for another member's live reply; and `ReportSubject(profile:_:)` for anyone else's profile. Recommendations, Want to watch, statuses, earlier discussions, and the viewer's own content offer none. `ReportReason` lists the six reasons in the server's order and words. |
| `ReportModel` | ScreenrKit `Reports/` | `@Observable`: the open `form`, its `reason` and note, which stops at 500 UTF-16 code units, its `phase` (`editing`, `sending`, `failed`, or `sent`), and the `prompt` that follows a report. `.report(_:reason:note:)` sends the report. |
| `ReportSheet`, `.reporting(_:)` | `Screenr/Shared/ReportSheet.swift` | The form, through `.keyboardSafeSheet(item:content:)`, and the alert that follows it. The notice sits below the form in a `FormNoteBar`, as the feedback form's length does, since the accessibility audit failed it as a grouped list's footer for Dynamic Type. |

- **Where:** a flag at the end of an entry's actions, after Share, named
  "Report post", "Report comment", or "Report review"; Report after a live
  reply's Reply; and Report after Block in a profile's More actions.
- **Form:** "Why are you reporting it?" with the six reasons and none chosen,
  "Add details (optional)", and "Screenr’s owner reviews every report within
  24 hours.", which adds "You won’t see this post anymore." for a post,
  comment, or review. Report needs a reason, and the form can't close while
  the report sends. A failure keeps the form open with the server's words.
  A blank note sends none.
- **After a report:** the form closes and the screen reads again. The server
  then hides a reported entry, with its card, from the reporter, and sends a
  reported reply as unavailable; a reported profile stays. Once the sheet has
  closed, `formClosed()` shows "Thanks for reporting", which offers to block
  the author. Block sends `relationship`'s block and reads the screen again;
  on the author's own profile, it runs the profile's Block instead, through
  `ProfileModel.block(_:onProfileOf:)`, which leaves for Friends.
- **Tests:** `ReportModelTests` cover the subjects each place offers, the
  form, the requests, and the offer, and check `ReportReason` against
  `rules/report-reasons`. `ReportTests` report a reply with a note, a review
  on a title page, and a profile against the `actions/report` fixtures, check
  that the viewer's own entries and replies offer no Report, decline and
  accept the offer, keep the form through the `actions/report/not-reportable`
  override, and audit the form.

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
  with unknown viewing options it leaves out. Each title's `access` and
  `matchingServiceIds` come from the server's
  [viewing access](../docs/title-availability.md#viewing-access), which the
  app never decides; `receive(savedServices:)` searches again when a screen
  read brings other saved services. Friends recommend adds Movies/TV
  and Show finished; finished titles start hidden. Edit services opens
  Settings over the tab.
- **Screen read:** the filters go in the read's path, as on the
  [web](../docs/title-suggestions.md#implementation): `services=mine`,
  `type=movie` or `type=tv`, and `finished=hidden`, so the server applies
  them before capping each list at 50 titles and a filtered list still
  fills. `Destination.search().screenPath` is Find's first read,
  `/search?finished=hidden`, and `FindModel.screenPath` builds the rest;
  `FindView` passes each change to `ScreenModel.change(path:)`, which reads
  at once. The lists on screen stay filtered on the phone until that read
  answers. A read that hides finished titles counts them in
  `finishedRecommendations`, which Show finished's empty message adds to any
  the phone hides. An empty list that a filter narrows keeps its filters and
  explains them; only an unnarrowed one shows "No suggestions yet." or "No
  recommendations yet."
- **Want to watch:** Friends recommend's one-tap save sends `activity` with
  the `friends_recommend` surface, then reads the screen again. Another
  status, or the viewer's own Recommend, opens the title instead.
- **Wording:** `FindWording`, `TitleSuggestion.reasons`,
  `FriendsRecommendation.recommendedByText`, and `.action` word everything
  as the web does.

`FindSearchTests`, `FindWantToWatchTests`, and `FindListsTests` cover the
model with `FindAPI`, a fake that answers searches by their text, and
`TestClock`. `FindTests` drives the tab: searching, opening a result,
Friends recommend, the reads each filter sends, every `screen/search` and
`actions/search` fixture, and a loaded poster in place of its title's
initial. `screen/search/viewer-statuses` shows Cam's own statuses, free
options, unknown availability, and no saved services.
`screen/search/finished-hidden` and `finished-shown` read Alice's Movies
after she finishes both movies her friends recommend, with finished titles
hidden and shown. Other filtered reads get the viewer's `screen/search`
fixture, which the phone filters.

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
| `TitleRow` | `Screenr/Shared/Titles/` | A title's `PosterImage`, name, kind and year, release status and TMDB user score, and where it streams, with optional lines after them. As on the web at phone widths, it leaves out the overview. At accessibility sizes the text moves beneath the poster. Put it in a `NavigationLink`. |
| `TitleStatusLine` | `Screenr/Shared/Titles/` | The [release status](../docs/title-availability.md#release-status-implementation), such as "In theaters · Digital Nov 20", with the [TMDB user score](../docs/title-catalog.md#tmdb-user-score-implementation) beside it, the `TMDBLogo` asset and a percentage such as 73%, in title rows, Find a title's suggestions, and atop Where to watch, or nothing without a label or score. |
| `ViewingLinesView` | `Screenr/Shared/Titles/` | "On Netflix, Hulu" and "Free on Tubi TV", with the title's `matchingServiceIds` marked, or why there are no options. `savedBy: .eitherPerson` marks either person's services, as Watch together does. |
| `TitleKindPicker`, `TitleKindFilter` | `Screenr/Shared/Titles/`, ScreenrKit `Titles/` | The All, Movies, and TV filter that Watch together and Want to watch pages share. Each choice keeps the list's order. |
| `ViewingAttribution` | `Screenr/Shared/Titles/` | JustWatch's credit beneath a list of titles' viewing options. |
| `Title.kindAndYear` | ScreenrKit `Titles/` | "Movie · 2024", or only the kind without a release date. |
| `TMDBScore.text` | ScreenrKit `Titles/` | The server's whole percentage, such as "73%". The app never computes a score. |
| `TitleRelease.text` | ScreenrKit `Titles/` | "In theaters", then each upcoming date's label as the server worded it, joined with " · ", or nil when there is none or the release data could not be loaded. The app never derives a status from the dates. |
| `TitleViewing.lines(matchingServices:savedBy:)` | ScreenrKit `Titles/` | The lines `ViewingLinesView` shows, marking the saved services that the server found offer the title. |
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
| `TitlePageModel` | ScreenrKit | `@Observable`: one write at a time, each followed by a read. Recommend (no surface), Add to top 10 and its removal, the status sheet's choices (Finished sends today; Want to watch sends `surface`), the finished date, the review, and the prompts: `leaving`, the confirmation before a ranked Recommend leaves the top 10, and `sheet` (`.status`, `.review`, or `.replace`). `reconcile(with:)` keeps the page's latest `header`, which the sheets show, and closes a prompt the page no longer needs. A failure shows beneath its control. |
| `ReviewEditor` | ScreenrKit | The review form's draft, which starts from the saved review when the form opens and lasts until it closes, its save and removal, and the removal's confirmation. |
| `FriendActivity.lineParts`, `lineGroups`, `sentence` | ScreenrKit | The friend line in the web's words, such as "Recommended by Ben Ortiz (#1) · Cam Rivera wants to watch", as pieces that wrap between words. On a phone, each group starts its own line in place of " · ". |
| `WatchAvailability.notice`, `emptyMessage`, `checkedLabel()` | ScreenrKit | Where to watch's messages, in the web's words. |
| `CalendarDay` | ScreenrKit | `YYYY-MM-DD` days, such as today for Finished: Gregorian days in the reader's time zone, whatever calendar the phone uses. |
| `TitleHeaderView`, `WatchStatusSheet`, `ReviewSheet`, `TopTenReplaceSheet`, `AvailabilitySection`, `TrailerSection` | `Screenr/TitlePage/` | The views. The status button opens a sheet of choices with Last finished, since a SwiftUI `Menu` holds no date field. It ends in `MenuChevron`, from `Screenr/Shared/`, the down chevron that marks a control as opening a menu of choices. |

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
- **Sheets:** the status, review, and replacement sheets, and the
  confirmations of the header's Recommend and the feed's actions, sit outside
  the screen's content, as the profile's top 10 editor does, so a failed read
  beneath leaves them open with the page's last header and the review's
  draft.
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
  as full-screen video, turn to landscape. The Simulator's tests load no
  video, so this rests on WebKit's documented behavior.
- **Tests:** against the fixture API, `AppServices.trailers` is
  `TrailerLoading.recording`, which writes `WEB <url>` to the request log and
  loads nothing, so `TitleTests` checks that the embed is asked for only
  after Play trailer, without the network.

`TitleTests` also covers the watch status and finished date, the status
button's chevron with and without a status at the default and largest text
sizes, Recommend and its confirmation, the friend line, adding to a full top
10, the review and the Recommend confirmation with a failed read beneath
each, which `FixtureOutage` causes, the largest text size, and every
`screen/title` fixture. The status and
replacement sheets are system lists, so their audit is
`performSettingsAudit()`, and the largest text size test reaches each of
their controls instead.
`screen/title/full-top-ten` shows Winter Garden while Alice's top 10 is full,
`screen/title/finished-review` shows Paper Lanterns, which Alice finished,
reviewed, and ranks #2, and `screen/title/in-theaters` shows The Quiet Orchard
in theaters with its digital date ahead and a TMDB user score of 73%.

## Friends and profiles

Friends, profiles, Want to watch pages, and Watch together follow the web's
People, profile, [Want to watch](../docs/want-to-watch.md), and Watch
together pages. Their screens are `FriendsView`, `ProfileView`,
`WantToWatchView`, and `WatchTogetherView` in `Screenr/Screens/`, with their
parts in `Screenr/People/`, and their behavior is in ScreenrKit's `People/`.

| Piece | Where | What it does |
| --- | --- | --- |
| `FriendsSections`, `FriendsModel` | ScreenrKit `People/` | Friends in the web's order: Requests, Friends, Sent requests, People you may know with their mutual friends, and Blocked people. Accept, Decline after a confirmation, Cancel, Send friend request, and Unblock go through `relationship`, one at a time, and the page reads again after each. `reconcile(with:)` closes Decline's confirmation once a read no longer has the request. A failed action's message stays with its person. `searchDestination` opens an exact username's profile. |
| `Relationship`, `ProfileModel` | ScreenrKit `People/` | `Relationship(profile, viewer:)` is `own`, `friend`, `requestSent`, `requestReceived`, or `none`, and gives the visible `action`, such as Watch together or Accept friend request, and the More actions `menu`. Unfriend and Block confirm in the web's words, and `reconcile(with:)` closes Unfriend's confirmation once a read shows the friendship ended. Report follows them in More actions; see [Reports](#reports). |
| `WatchTogetherSection` | ScreenrKit `People/` | Ready to watch, Not on your services, and Availability unknown, filtered by [`TitleKindFilter`](#title-lists); and the count and empty states. Each shared title is a [`TitleRow`](#title-lists) that marks the services either person saved. |
| `WantToWatchSection`, `WantToWatchEmpty` | ScreenrKit `People/` | A Want to watch page's Ready to watch and Availability unknown, filtered by `TitleKindFilter`; the count of titles to watch now; and why nothing is ready, worded for the viewer's own page or a friend's. Each title is a `TitleRow` that marks the viewer's saved services. |
| `ListModePicker`, `Destination.ListMode` | `Screenr/Shared/Titles/`, ScreenrKit `Navigation/` | The At home and In theaters switch between the introduction and the filter on Want to watch pages and Watch together. Each mode is its own destination, `mode=theaters` in its path, and choosing one replaces the screen on top of the tab with `Router.replace(_:with:)`, so Back leaves the page. |
| `InTheatersSections`, `InTheatersList` | ScreenrKit `People/`, `Screenr/People/` | [In theaters](../docs/want-to-watch.md#in-theaters) on both pages: the count, In theaters now, the empty states, and Availability unknown, from `WantToWatchInTheatersScreen` or `WatchTogetherInTheatersScreen`. Each movie is a `TitleRow` with its release status and TMDB user score and no viewing options. |
| `TopTenSection`, `TopTenRow` | `Screenr/Shared/TopTen/` | A profile's Top 10 heading and its row of ranked posters, each a link named like "#1 Night Crossing" that opens the title. The row only displays the list. Another member's empty list shows nothing; the owner's explains how to start one. `TopTenSection(entries:owner: .viewer(edit:))` adds Edit to the heading. |
| `TopTenEditorModel` | ScreenrKit `People/` | `@Observable`: the [top 10 editor](#top-10-editor)'s entries, one change at a time: `drop(_:dragged:)` and `move(_:toRank:)` send `top-ten` `move`, and `remove(_:)` sends `remove`. A change shows at once and a failed one returns the list to its order before the change, with `failure`. `reconcile(with:)` takes the profile's reads. |
| `ProfileWithTopTenEditor`, `TopTenEditorList` | `Screenr/Shared/TopTen/` | The profile destination with the editor sheet that Edit opens, and the sheet's list. |
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
  closes the person's profile, their Want to watch page, and Watch together
  on every tab with
  `Router.close(where:)`, leaves "You blocked …" for Friends with
  `ShellModel.leaveNotice(_:on:)`, and opens Friends. Friends shows the
  notice until it is dismissed or Friends is left. Block from the offer after
  [reporting](#reports) the person or their content on their profile does the
  same.
- **The member's own profile:** the You tab's root is `ProfileView` with
  `Relationship.own`: no relationship action or More actions, and the top
  10's empty state. Its `editTopTen` closure adds Edit to the Top 10 heading
  while the list has titles. `DestinationView` shows every profile through
  `ProfileWithTopTenEditor`, whose closure opens the
  [top 10 editor](#top-10-editor).
- **Want to watch:** the viewer's own profile and an accepted friend's, whose
  `canRead` is true, link to `/people/<username>/want-to-watch` above the
  Friends list; the link's identifier is `want-to-watch`, apart from feed
  entries' Want to watch. The page lists what the server sends, which holds
  only titles the viewer can watch now or whose availability is unknown,
  judged by the viewer's own services. Save your streaming services opens
  Settings over the tab, and each title opens its page through
  `WantToWatchScreen.destination(of:)`, which reports the `title` surface, as
  the web's links do. Others' pages answer "Want to watch not found." In
  theaters lists the owner's movies in US theaters now, whatever services
  anyone saved, and each opens through
  `WantToWatchInTheatersScreen.destination(of:)`, also with `title`.
- **Watch together:** a friend's profile links to
  `/watch-together?with=<username>`. Save your streaming services opens
  Settings over the tab, and each title opens its page through
  `SharedTitle.destination`, so a Want to watch saved there reports the web's
  `watch_together` surface. In theaters lists the shared movies in US
  theaters now, and `WatchTogetherInTheatersScreen.destination(of:)` keeps
  that surface.
- **Tests:** `FriendsModelTests`, `ProfileModelTests`, `WantToWatchTests`,
  `InTheatersTests`, and `WatchTogetherTests` cover the models against the
  fixtures and `RecordingAPI`. The UI tests `FriendsTests`, `ProfileTests`,
  `WantToWatchTests`, and `WatchTogetherTests` drive the journeys, check each
  write in the request log, audit at the largest text size, and render every
  `screen/people`, `screen/profile`, `screen/want-to-watch`, and
  `screen/watch-together` fixture. `app.person(_:)`
  finds a Friends row by username, `ScreenFixtureFile` reads a screen
  fixture's viewer, path, and body, and `app.openFixture(_:)` opens its link
  in the running app, so one launch for each viewer renders all of that
  viewer's fixtures. Accept, Send friend request, and Watch together use
  `.buttonStyle(.accent)`, and `FriendsTests` measures their labels with
  `labelContrast()` in dark mode.
- **Confirmations:** Unfriend's, Block's, and Decline's confirmations sit
  outside the screens' content, as the feed's do, so a failed read beneath
  leaves them open, and `reconcile(with:)` closes one that a read makes
  stale. `FriendsTests` and `ProfileTests` fail a poll beneath Decline's and
  Unfriend's with `FixtureOutage`.
- **iOS 27 controls:** a confirmation dialog shows as a popover without
  Cancel, at the control that asked or at the top of the screen, or, for one
  that a whole screen presents, sometimes as a sheet with Cancel in the
  middle of the screen; runs of the same test have seen all three.
  `app.confirmationButton(_:)` finds a dialog's button in any of them, and
  `app.cancelConfirmation()` closes it with Cancel or with a tap on
  `PopoverDismissRegion` away from the dialog. Avoid `ViewThatFits`, which
  the Dynamic Type audit fails, and use symbol buttons rather than text
  buttons in toolbars, which the audit also fails.

### Top 10 editor

Edit on the member's own profile opens a sheet with their top 10 as a
system list, following the
[decision](../docs/ios-app.md#top-10-editing-in-a-list-sheet--2026-10-13) and
the web's [top 10 rules](../docs/profile-top-ten.md#reorder-in-an-edit-mode--2026-10-12).
`TopTenEditorModel` holds the behavior:

- **Reordering:** each row shows its reorder handle. A drop sends one
  `top-ten` `move` with the dragged entry's new rank. When two neighbors swap,
  either one's move gives the same order, so the model sends the dragged one.
- **Removing:** swiping a row left offers Remove, which sends `remove` and
  keeps the title's Recommend. The rows below move up.
- **Saving:** one change saves at a time, and the list shows it at once. A
  failed save returns the rows to their order before the change and shows
  the reason above them. A successful one reads the profile again.
- **Reads:** the profile beneath keeps polling. A read whose list differs
  from the last one replaces the editor's, after any save in flight, so a
  change on the web shows; an unchanged read, like the fixture API's after a
  write, keeps the saved change.
- **Labels:** each row's accessibility label, such as "#1 Night Crossing",
  also names its handle, "Reorder #1 Night Crossing", which UI tests find
  and drag.

`TopTenEditorList` is a UIKit collection view list, with SwiftUI rows through
`UIHostingConfiguration`, since SwiftUI's `List` shows reorder handles only
in edit mode, where its rows do not swipe. A failed read beneath the sheet
leaves it open.

`TopTenEditorModelTests` cover the model against `RecordingAPI`, a gated fake
for saves in flight, and the fixture API's refusal. `TopTenEditorTests` drag
Harbor Lights to #1, roll back the move that the
`actions/top-ten/move-unlisted` override refuses, remove Paper Lanterns by
swiping, check the writes in the request log, and reach every handle at the
largest text size.

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
   show beneath. `ShareModel.page(for:)` makes each page's model and counts
   its saves, even from a page the member left, so Close stays off while
   `isSaving`: closing the sheet ends the extension, which could cut off a
   save the server had applied.
4. **The session:** the extension reads the app's session token from the
   shared Keychain group and never signs in. Signed out, it asks the member
   to sign in in the app; a 426 shows Update Screenr; a member without a
   profile gets the server's 403, and is sent to the app to finish joining.

| Piece | Where | What it does |
| --- | --- | --- |
| `ShareViewController` | `ScreenrShare/` | The principal class. It runs each share with the process's `AppServices(…, host: .shareExtension)`, whose client marks no [visits](#visits), with `Telemetry.localOnly()`, logs to `share.ndjson` in the app group's log directory through one writer per process, hosts `ShareView`, and ends the host's request when the sheet closes. |
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
- **Ending the request:** Close completes the host app's request, and the
  host closes its share sheet too. A swipe down takes the sheet without
  Close: iOS calls `viewDidDisappear` and shows the host's share sheet
  again, so the extension cancels the request with
  `CocoaError(.userCancelled)`, as the member's choice. The services'
  `ShareEndings` report which; under the fixture API they add a `SHARE`
  line to the request log. Until a request ends, iOS keeps its view
  controller, with its `ShareView` and `ShareModel`, in the extension's
  process; in a Simulator, a swiped share's controller stayed until the
  host app quit. Once a request ends, iOS may stop the process, so a save
  the member started before a swipe, which Close's `isSaving` rule cannot
  stop, relies on [writes in the background](#screenrkit-api) to finish.
  Backgrounding the app with the sheet open calls no `viewDidDisappear`.
- **Services:** iOS may keep the extension's process for the next share, so
  shares reuse one set of services through `ExtensionServices`, as pushes do
  in the [notification extension](#push-content), rather than each opening
  its own connections. `ExtensionServices.share(arguments:_:)` runs a share
  until `ShareModel.finished()`: the sheet has closed, with Close or a swipe,
  and every request the share sent has answered. After the sheet closes, the
  share sends nothing more, and its later requests, such as the page's read
  after a save, fail as `.cancelled`. So when the member signs in again or
  out in the app and a later share replaces the services, the old ones close
  only once a save still finishing answers.
- **Signing:** the bundle ID is the app's with `.Share`, and
  `Config/ScreenrShare.entitlements` holds only the app group. See
  [Apple Developer](../docs/running-screenr.md#apple-developer).
- **Tests:** `SharedContentTests`, `ShareModelTests`, and `ShareServicesTests`
  cover ScreenrKit's part, and `tests/app/shared-links.test.ts` the server's.
  `ShareExtensionTests` drives the extension from the app's own share sheet,
  where iOS lists Screenr Dev for a title's link: it finds the title, shows
  its friends, saves Want to watch, and closes, and the request log shows
  what the extension sent and that Close completed the request. A second
  share then finds the title again, and a swipe down cancels it and returns
  to the app's share sheet. The
  [hosted tests](#hosted-tests) check that the built extension's
  `Info.plist` has the app's settings. To try a link from
  another app in your Simulator, launch Screenr Dev with fixture arguments,
  such as `-ScreenrFixtures "$PWD/ios/ScreenrKit/Fixtures" -ScreenrFixtureLog
  /tmp/requests.log`, open a TMDB or IMDb title in Safari, and choose Page
  Menu, Share, then Screenr Dev. The fixture API answers `resolve-title`
  with the fixture for the same query, or another title's. Real links
  resolve only against a server, such as `npm run dev` with a TMDB token.

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
  and returns them to the shortcut. When more remain, it adds how many, as
  in "and 61 more", from the read's `recommendationCount`, which counts
  every unfinished title, not only the 50 listed, or from the list's length
  when an older server omits it. Open Friends recommend opens the app at
  Find a title's Friends recommend. Both it and Add to Want to watch's
  suggestions read Find's first read, `/search?finished=hidden`, so finished
  titles, which neither offers, leave room for others in the capped list,
  and `finishedRecommendations` tells "You finished every title your friends
  recommend." from "No recommendations yet."
- **Visits:** the actions read screens with `.screen(path:visit: .never)`, so
  they never carry the app's [visit](#visits), which stays due for the
  app's next screen.
- **Spotlight index:** `ShellModel`'s `onScreen` hands `TitleSpotlight` every
  screen that loads. A feed or profile entry names the viewer's Recommend,
  status, and top 10 rank for its title, and the viewer's own review counts
  too; Friends recommend names their status and Recommend; and the viewer's
  own Want to watch page names each of its titles. A title page without any
  of these removes its title. Finding the titles and writing them, poster
  lookups included, run in order off the main actor. Each title is indexed
  once until it changes, and `TitleSpotlight.record`, a file in Caches,
  keeps the indexed titles across launches, so a launch writes only what
  changed. iOS neither backs up nor restores Caches or the index, so a
  restored iPhone indexes every title again. An unchanged poll never
  reaches Spotlight. An item's identifier is the title ID, with its name,
  "Movie · 2024", and the poster when the image cache already holds it, so
  indexing downloads nothing. Nothing leaves the device.
- **Opening a result:** selecting a result continues
  `CSSearchableItemActionType`, and `AppRootView` opens the title with
  `router.open(_:)`, as a link would.
- **Clearing:** when the session ends, by signing out, the server ending it,
  or deleting the account, `SessionStore.onEnd` removes every item and the
  record. A launch without a session removes them too, since the session
  may have ended in another process.

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

Siri's spoken phrases need a device.

## Fixtures

Server tests write JSON fixtures into `ScreenrKit/Fixtures/`. The directory
is outside the package's targets, so tests find it from their own source
path, as `TestFixtures.directory` in `Tests/ScreenrKitTests/Support/` does.
This works under `swift test` and in the Simulator, which reads the Mac's
file system. `FixtureDecodingTests` decodes every fixture as the model its
action returns, and `RequestTests` checks that the request functions build
the recorded requests. `AuthFixtureTests` runs the client against Better
Auth's recorded answers: a sign-in's `set-auth-token` and the `user.id` that
a confirming sign-in checks. Two folders hold the server's other
recordings, which `Fixture.all(in:)` leaves out: `push/`, the pushes the
worker sent (see [push tests](#push-tests)), and `rules/`, the server's
rules, such as `before-profile`, the actions a member can use before setup,
which the fixture API applies, and `report-reasons`, the report form's
reasons, which `ReportModelTests` checks the app's against.

## Hosted tests

The ScreenrAppTests target runs inside Screenr Dev, with its entitlements
and its embedded extensions, for what package tests cannot reach:

- `SystemKeychainTests` writes, reads back, replaces, and deletes an item of
  its own through `SystemKeychain` in the app group's access group, and
  checks that the item stays in that group, readable after the first unlock
  and only on this device.
- `EmbeddedExtensionTests` reads each built extension's `Info.plist` with
  `AppConfiguration`, which would otherwise stop the extension the first
  time iOS starts it, and checks its bundle ID, extension point, and
  principal class.
- `NotificationServiceTests` hands recorded pushes to the notification
  extension's `NotificationService`, whose sources the target compiles,
  with the fixture arguments kept in the app group as Screenr Dev's launch
  keeps them, and checks the alert it delivers. See
  [push tests](#push-tests).

### Shared cases

`ScreenrKit/SharedCases/` holds hand-written cases that the web's tests and
ScreenrKit's run alike, so the two clients cannot drift apart on rules that
both still apply. `feed-layout.json` lays out feeds after New activity
([unified title feed](../docs/title-feed.md#new-activity)): the web's
`tests/app/feed-layout.test.ts` and `SharedFeedLayoutTests` run every case.
`member-routes.json` lists member paths with their canonical paths and route
patterns, which the web's `src/member-routes.ts`, `Destination`, and
`RoutePattern` must agree on: `tests/app/member-routes.test.ts`,
`DestinationTests`, and `RoutePatternTests` run every case. The web's routes
also hold Find a title's filters and a paged history's window, which the app
adds to its screen reads through `FindModel` and `HistoryWindow`, so those
cases stay in the web's test.
Edit the cases by hand, and run both suites after a change.

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
- **Routes and errors:** `.route` for a `RoutePattern`, `.error` for an
  error's domain and code, without its message, and `.codingPath` for where
  a response body didn't decode, as keys and array indexes.

Each line goes to the unified log under subsystem
`com.artisanalsoftware.Screenr`. Lines at info and above also go to the log
file, and in Release builds, lines at warning and above go to Sentry logs.

The log file, `Library/Logs/Screenr/app.ndjson` in the app group container,
holds one JSON object per line: `time`, `level`, `category`, `message`,
`launch` (an ID for each launch), and `fields`. One task writes the file in
order, so logging never waits on the disk. When the file would pass 256 KB it
becomes `app.1.ndjson`, so the log keeps at most two files.
Another process writes a file of its own name in the same directory, such
as the [share extension](#share-extension)'s `share.ndjson` and the
[notification extension](#push-content)'s `notifications.ndjson`, and
`LogFile.recentTails(maximumBytes:)` returns each file's newest complete
lines for the [feedback form](#feedback). Each file has one writer per
process: an extension that iOS keeps running between requests installs its
file once, as `LogRouter.file(_:in:)` does, since two writers would each
write every line and rotate away each other's files.

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
  reports, such as a response the app can't read, app hangs, MetricKit
  diagnostics, Sentry logs at warning and above, and user feedback from the
  [feedback form](#feedback). Traces cover app launch and API calls, for one
  launch in five.
- **MetricKit attachment:** each MetricKit event also attaches iOS's raw
  diagnostic as JSON, `MXDiagnosticPayload.json` in sentry-cocoa 9.32.0,
  through `enableMetricKitRawPayload`. Sentry keeps 250 frames of the call
  tree that sentry-cocoa flattens into the event's stack trace, and a hang's
  tree can run to thousands
  ([#631](https://github.com/jubishop/screenr/issues/631)); the attachment
  keeps every frame's binary, offset, and sample count. Besides stack
  addresses, it holds metadata much like the event's contexts, such as the
  app and OS versions, the device type, and the region, and no member
  content.
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
  with its request ID.
- **Failed calls:** a failed call's line adds `outcome=failed` and its
  `error`, the `APIError` kind, such as `notFound`. A 4xx logs at info,
  since most are expected answers, such as not found or an ended session,
  and a cancelled call logs at info with `outcome=cancelled`. Any other
  failure, such as a 5xx, a transport failure, or a response the app can't
  read, logs a warning, whatever its status, and marks its breadcrumb and
  trace as errors. A body that doesn't decode, such as a 200 after the
  server's payload changed, also logs `decoding`, `DecodingError`'s case,
  and `coding_path`, the keys and array indexes to the value, such as
  `conversations[1].activityAt`, but never a value. A response the app
  can't read also opens a Sentry issue through
  `telemetry.capture(_:requestID:)`, once per route in a launch, since an
  open screen polls the same route every three seconds.
- **Polls:** a successful [poll](#polling), usually an unchanged 304 every
  three seconds, logs only at debug level, which the log file leaves out,
  and adds no breadcrumb or transaction, so polling cannot crowd the log
  tail that feedback attaches or the breadcrumbs before a crash. Writes,
  failures, and first reads are recorded in full.
- **Sign-in failures:** Google's token endpoint is called on the transport
  directly, so Telemetry never sees it. A Google or Sign in with Apple
  attempt that fails before it reaches the server, other than by the person
  cancelling, logs a `Log.session` warning. Google's names the
  `GoogleSignInError` case, with the token endpoint's status when it refuses
  the code, and Apple's names the error's domain and code. Neither holds
  Google's OAuth error, an authorization code, or a token.
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
script prints a warning and skips the upload, except in `bin/testflight`'s
archives, which set `SCREENR_REQUIRE_SENTRY_SYMBOLS=YES` so that the archive
fails instead. A failed upload always fails the archive. To confirm that
Sentry has an archive's symbols:

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
- **New extensions:** the App Store Connect key cannot register a new
  extension's App ID. One archive signed through the Mac's Xcode account,
  `bin/ios-packages xcodebuild archive … -allowProvisioningUpdates` without
  the key flags, registers it, and the release script's key signs it from
  then on. Neither archive needs uploading. The same goes for a capability
  the key's API can't enable, such as Declared Age Range; see
  [Apple Developer](../docs/running-screenr.md#apple-developer).
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
- **Keyboard deadlock:** iOS 26 and 27 can deadlock an app whose keyboard
  lays out for a text field inside a SwiftUI `ScrollView` while SwiftUI's
  `AsyncRenderer` thread animates. The main thread, holding Core Animation's
  transaction lock, walks the responder chain for the keyboard's input
  assistant into the scroll view, which waits for SwiftUI's update lock; the
  renderer holds that lock and waits in `-[CALayer addPresentationModifier:]`
  for Core Animation's. It is reported to Apple as FB22832280
  ([Open Radar](http://openradar.appspot.com/FB22832280)). As of
  2026-11-05 no iOS release fixes it: the report is still open, its latest
  comment found it in the iOS 27.0 beta, and the release notes of iOS
  27.0.1 through 27.2, the iOS 27.3 beta, and iOS 26.6 through 26.7.2 list
  no fix. Screenr's checks then ran on the iOS 27.0 Simulator. In Screenr
  it struck when a sheet closed over a feed's open composer: UIKit brings
  the keyboard back as the closing sheet animates. On 2026-11-05 it froze
  the app in 1 of 100 runs of `testKeepsAnUnsentCommentBeneathTheSheet`
  beside other Simulators' UI tests. So the app never brings a keyboard back
  during a transition:
  - `.keyboardSafeSheet(item:content:)` ends editing before every sheet
    opens, and `tests/test_ios_sheets.py` fails when the app or an extension
    presents a sheet, cover, or popover any other way.
  - `.keyboardSafeNavigation(_:)` ends editing whenever a tab's navigation
    path shows a new screen, before the transition starts. Otherwise editing
    ends inside a Core Animation commit as a push starts or a replaced screen
    goes, and UIKit brings the keyboard back as the pop animates.
  - A composer takes focus only as it opens, not each time its screen
    appears again, such as after a pop or a tab switch.

  Samples on 2026-11-05 found the renderer animating during navigation
  transitions, sheets, and presses of toolbar glass buttons, and not during
  New activity, tab switches, confirmation dialogs, menus, or the share
  sheet's close. `FeedTests.testKeepsAnUnsentCommentAcrossScreens` covers
  the pop after a push from the feed or from a link, and a tab switch. A UI
  test that logs "App event loop idle notification not received" may be
  such a hang: run `sample` on the app's process in its Simulator while the
  test waits, and read the main thread.
