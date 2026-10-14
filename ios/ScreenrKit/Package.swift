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
  targets: [
    .target(name: "ScreenrKit", swiftSettings: swiftSettings),
    .testTarget(
      name: "ScreenrKitTests",
      dependencies: ["ScreenrKit"],
      swiftSettings: swiftSettings
    ),
  ],
  swiftLanguageModes: [.v6]
)
