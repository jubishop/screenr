# iPhone app rules

These rules apply to everything under `ios/`, in addition to the root
[`AGENTS.md`](../AGENTS.md). Read the [iPhone app guide](README.md) for the
layout, commands, and toolchain notes, and the
[accepted decisions](../docs/ios-app.md) before product work. They adapt
[PodHaven](https://github.com/jubishop/podhaven)'s Swift rules.

## Project

- **No Xcode:** work from the command line and the Simulator. Write no
  `#Preview` blocks or preview content.
- **Synchronized folders:** `Screenr/`, `ScreenrShare/`, and
  `ScreenrUITests/` are synchronized folder groups. Add, move, or delete files on disk; never edit
  `project.pbxproj` to register a file. Change it only for a new target,
  capability, or setting that cannot live in an `.xcconfig` file.
- **Settings:** build settings live in `Config/*.xcconfig`. Put a standard
  `Info.plist` key in `Config/Screenr.xcconfig` as an `INFOPLIST_KEY_`
  setting when Xcode supports one, and a variant value in `Dev.xcconfig` or
  `Release.xcconfig`.
- **Code placement:** `ScreenrKit` holds the API models and client, session
  and Keychain storage, logging, push content, and `@Observable` view models.
  The app target holds SwiftUI views and the app lifecycle, and the
  `ScreenrShare` extension target its own views.
- **Dependencies:** `sentry-cocoa` is the only third-party package. Use the
  platform or small in-house code for everything else.
- **Fixtures:** `ScreenrKit/Fixtures/` holds JSON that server tests write.
  Regenerate it with the server's fixture tooling; never edit it by hand.

## Swift

- **Language:** Swift 6 mode, with complete strict concurrency and strict
  memory safety. Default actor isolation is MainActor in the app target and
  nonisolated in ScreenrKit and the UI tests.
- **Warnings:** warnings are errors. Every build and test run ends with zero
  warnings; `bin/check-ios` enforces it.
- **Formatting:** run `bin/format-swift` on changed files. The app's build
  phase fails on unformatted Swift: 2-space indents and 100-column lines.
- **Errors:** no `try?`; use `do`/`catch`. Catch where the code can recover or
  report the failure, and otherwise propagate. Never turn an error into a
  value that looks like success.
- **Safety:** no force unwraps or `try!`; use `guard` or handle the error. Do
  not use `map` or `flatMap` to unwrap optionals. Avoid `@unchecked`,
  `@retroactive`, and `unsafe` unless they are necessary.
- **Concurrency:** no `Task.detached`; use `Task { }` and keep handles for
  long-lived tasks. Prefer `@MainActor` declarations over `MainActor.run`.
  Wait with async/await or continuations, never by polling.
- **Types:** model state as enums rather than Bool flags. Prefer `struct`;
  use a `class` only for reference identity or shared mutable state. Put
  protocol conformances on the main declaration.
- **Size:** keep each file under 1,000 lines.
- **Comments:** use `//`, not doc comments, and only when needed. Do not cite
  issues, pull requests, or repository docs in code comments.

## Interface

- **Look:** use standard iOS 27 components, system fonts with Dynamic Type,
  and the `AccentColor` tint. Do not copy the web's custom components.
- **Icons:** SF Symbols only, through `Image(systemName:)` or
  `Label(_:systemImage:)`. Add no icon images or icon catalogs.
- **Accessibility:** required for every UI change. Give VoiceOver accurate
  labels, values, traits, and actions, hide decorative elements, and support
  Dynamic Type. UI tests run `performAccessibilityAudit()` on the screens
  they reach.
- **Views:** keep views declarative. Put behavior in ScreenrKit view models.

## Tests

- **Red-green:** a behavior change needs a test that fails before the change
  and passes after it.
- **ScreenrKit:** Swift Testing, run with `swift test`. Fake the network,
  Keychain, and other system boundaries behind protocols so ScreenrKit's own
  logic runs. Package tests have no host app or entitlements.
- **UI journeys:** XCUITest in `ScreenrUITests`, against in-process fakes
  rather than a server. Mark test methods that drive the app `@MainActor`.
- **Simulators:** never use a shared booted Simulator. `bin/check-ios`
  creates its own; for direct `xcodebuild` runs, create and delete one as the
  [guide](README.md#run-the-dev-app) shows.
- **Before pushing:** run `bin/check-ios` locally before every push that
  changes `ios/`, including regenerated fixtures; Markdown-only changes are
  exempt. A pre-push hook enforces it; never bypass it with `--no-verify`.
  There is no remote iOS CI. See
  [iOS checks before a push](../docs/development-workflow.md#ios-checks-before-a-push).
