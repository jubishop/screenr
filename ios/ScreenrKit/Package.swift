// swift-tools-version: 6.4

import PackageDescription

let swiftSettings: [SwiftSetting] = [
  .defaultIsolation(nil),
  .strictMemorySafety(),
  .treatAllWarnings(as: .error),
  .enableUpcomingFeature("ExistentialAny"),
  .enableUpcomingFeature("MemberImportVisibility"),
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
  name: "ScreenrKit",
  platforms: [.iOS(.v27), .macOS(.v27)],
  products: [
    .library(name: "ScreenrKit", targets: ["ScreenrKit"])
  ],
  dependencies: [
    .package(url: "https://github.com/getsentry/sentry-cocoa.git", exact: "9.30.1")
  ],
  targets: [
    .target(
      name: "ScreenrKit",
      dependencies: [.product(name: "Sentry", package: "sentry-cocoa")],
      swiftSettings: swiftSettings
    ),
    .testTarget(
      name: "ScreenrKitTests",
      dependencies: ["ScreenrKit", .product(name: "Sentry", package: "sentry-cocoa")],
      swiftSettings: swiftSettings
    ),
  ],
  swiftLanguageModes: [.v6]
)
