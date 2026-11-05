import Foundation
import Testing

@testable import ScreenrKit

// The notification extension shares its client and image connections between
// pushes while the member's session stays the same, and closes them once it
// replaces them.
@MainActor
struct ExtensionServicesTests {
  // The session each request ran with.
  private func session(
    _ kept: ExtensionServices,
    arguments: [String] = ["ScreenrNotificationService"]
  ) async throws -> SessionStore? {
    var session: SessionStore?
    try await kept.run(arguments: arguments) { services in session = services.session }
    return session
  }

  @Test func sharesTheServicesWhileTheSessionStaysTheSame() async throws {
    let builder = ServicesBuilder()
    let kept = ExtensionServices { try builder.services(arguments: $0) }

    let first = try await session(kept)
    let second = try await session(kept)

    #expect(first === second)
    #expect(builder.transports.count == 1)
    #expect(builder.transports.first?.closed == 0)
  }

  // Signing in again or out in the app, or Screenr Dev's app launching with
  // other fixtures, replaces the services and closes the old ones.
  @Test func replacesTheServicesWhenTheSessionOrArgumentsChange() async throws {
    let builder = ServicesBuilder()
    let kept = ExtensionServices { try builder.services(arguments: $0) }
    let first = try await session(kept)

    try builder.keychain.write("next-token")
    let signedIn = try await session(kept)
    try builder.keychain.delete()
    let signedOut = try await session(kept)
    let still = try await session(kept)
    let otherFixtures = try await session(
      kept,
      arguments: ["ScreenrNotificationService", "-ScreenrFixtureViewer", "ben"]
    )

    #expect(signedIn !== first)
    #expect(signedOut !== signedIn)
    #expect(still === signedOut)
    #expect(otherFixtures !== signedOut)
    #expect(builder.transports.map(\.closed) == [1, 1, 1, 0])
  }

  // A push still reading with the replaced services keeps their connections
  // until it finishes.
  @Test func closesReplacedServicesOnceTheirLastRequestEnds() async throws {
    let builder = ServicesBuilder()
    let kept = ExtensionServices { try builder.services(arguments: $0) }
    let hold = Hold()
    let reading = Task {
      try await kept.run(arguments: ["ScreenrNotificationService"]) { _ in await hold.hold() }
    }
    await hold.arrival()

    try builder.keychain.write("next-token")
    _ = try await session(kept)
    #expect(builder.transports.map(\.closed) == [0, 0])

    hold.release()
    try await reading.value
    #expect(builder.transports.map(\.closed) == [1, 0])
  }
}
