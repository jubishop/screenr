import Foundation
import Testing

@testable import ScreenrKit

// The share extension's services: Screenr Dev hands its fixture arguments to
// the extension through the app group, and the extension's client marks no
// visits.
@MainActor
struct ShareServicesTests {
  private let suite = "ScreenrKitTests.\(UUID().uuidString)"

  private func handoff(_ variant: AppConfiguration.Variant) throws -> FixtureHandoff {
    FixtureHandoff(defaults: try #require(UserDefaults(suiteName: suite)), variant: variant)
  }

  private func forget() {
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
  }

  // The extension's Info.plist settings, which have no APNs environment.
  private func configuration() throws -> AppConfiguration {
    try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
  }

  @Test func devHandsTheAppsFixtureArgumentsToItsExtension() throws {
    defer { forget() }
    try handoff(.dev)
      .keep([
        "Screenr", "-ScreenrFixtures", "/fixtures", "-ApplePersistenceIgnoreState", "YES",
        "-ScreenrFixtureViewer", "nora", "-ScreenrFixtureLog", "/tmp/requests.log",
      ])

    #expect(
      try handoff(.dev).arguments(["ScreenrShare"]) == [
        "ScreenrShare", "-ScreenrFixtures", "/fixtures", "-ScreenrFixtureViewer", "nora",
        "-ScreenrFixtureLog", "/tmp/requests.log",
      ]
    )
  }

  @Test func aLaunchWithoutFixturesForgetsThem() throws {
    defer { forget() }
    try handoff(.dev).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    try handoff(.dev).keep(["Screenr"])

    #expect(try handoff(.dev).arguments(["ScreenrShare"]) == ["ScreenrShare"])
  }

  @Test func releaseBuildsNeitherKeepNorReadThem() throws {
    defer { forget() }
    try handoff(.release).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    #expect(try handoff(.dev).arguments(["ScreenrShare"]) == ["ScreenrShare"])

    try handoff(.dev).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    #expect(try handoff(.release).arguments(["ScreenrShare"]) == ["ScreenrShare"])
  }

  @Test func theExtensionsClientMarksNoVisit() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      do {
        try FileManager.default.removeItem(at: directory)
      } catch {
        Issue.record("Could not remove \(directory.path()): \(error)")
      }
    }
    let log = directory.appending(path: "requests.log")
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrShare", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixtureLog",
        log.path(),
      ],
      host: .shareExtension
    )

    _ = try await services.api.send(.screen(path: "/titles/tv/201"))

    #expect(
      try String(contentsOf: log, encoding: .utf8)
        == "GET /api/screenr/screen?path=%2Ftitles%2Ftv%2F201\n"
    )
  }

  // The extension handles no notifications, so it has no push system, even
  // when the app's fixture arguments choose a permission.
  @Test func theExtensionHasNoPushSystem() throws {
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrShare", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixturePush",
        "allowed",
      ],
      host: .shareExtension
    )

    #expect(services.push == nil)
  }
}
