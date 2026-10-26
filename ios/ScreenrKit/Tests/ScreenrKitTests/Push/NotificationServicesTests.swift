import Foundation
import Testing

@testable import ScreenrKit

// The notification extension's services: in Screenr Dev, its client reads
// from the fixtures the app hands it, and it has no push system of its own.
@MainActor
struct NotificationServicesTests {
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

  @Test func theExtensionReadsANotificationFromTheFixtures() async throws {
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
        "ScreenrNotificationService", "-ScreenrFixtures", TestFixtures.directory.path(),
        "-ScreenrFixtureLog", log.path(),
      ],
      host: .notificationExtension
    )

    let lookup = try await services.api.send(.notification(id: "18"))

    guard case .visible(let notification) = lookup else {
      Issue.record("Notification 18 should be visible")
      return
    }
    #expect(notification.item.kind == .comment)
    #expect(try String(contentsOf: log, encoding: .utf8) == "GET /api/screenr/notification?id=18\n")
  }

  @Test func theExtensionHasNoPushSystem() throws {
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrNotificationService", "-ScreenrFixtures", TestFixtures.directory.path(),
        "-ScreenrFixturePush", "allowed",
      ],
      host: .notificationExtension
    )

    #expect(services.push == nil)
  }
}
