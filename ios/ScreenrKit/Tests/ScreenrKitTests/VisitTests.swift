import Foundation
import SwiftUI
import Testing

@testable import ScreenrKit

// The visit flag rides only on the first screen read after launch, and on the
// first after each return to the foreground, so the server records the day
// for those reads and not for polls.
@MainActor
struct VisitTests {
  private func screenReply() throws -> RecordingTransport.Reply {
    .response(status: 200, body: try TestFixtures.body("screen/feed/default"))
  }

  private func visitFlags(_ test: TestClient) -> [String?] {
    test.transport.requests.map { $0.value(forHTTPHeaderField: "Screenr-Visit") }
  }

  @Test func flagsOnlyTheFirstScreenReadAfterLaunch() async throws {
    let test = try TestClient(
      token: "signed-token",
      visits: VisitTracker(),
      replies: [try .json(200, []), try screenReply(), try screenReply(), try .json(200, [])]
    )

    _ = try await test.client.send(.search("night"))
    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/people"))
    _ = try await test.client.send(.search("night"))

    #expect(visitFlags(test) == [nil, "1", nil, nil])
  }

  @Test func flagsTheFirstScreenReadAfterEachReturnToTheForeground() async throws {
    let visits = VisitTracker()
    let test = try TestClient(
      token: "signed-token",
      visits: visits,
      replies: try (0..<6).map { _ in try screenReply() }
    )
    visits.sceneChanged(to: .inactive)
    visits.sceneChanged(to: .active)
    _ = try await test.client.send(.screen(path: "/"))

    // A pause without leaving the foreground, such as Control Center, is
    // not a return.
    visits.sceneChanged(to: .inactive)
    visits.sceneChanged(to: .active)
    _ = try await test.client.send(.screen(path: "/"))

    // Nothing in the background is a visit; coming back makes the next read one.
    visits.sceneChanged(to: .inactive)
    visits.sceneChanged(to: .background)
    _ = try await test.client.send(.screen(path: "/"))
    visits.sceneChanged(to: .inactive)
    visits.sceneChanged(to: .active)
    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/people"))

    #expect(visitFlags(test) == ["1", nil, nil, "1", nil, nil])
  }

  // A visit the server did not answer, such as offline or before setup,
  // moves to the next screen read.
  @Test func movesAVisitToTheNextReadUntilTheServerAnswers() async throws {
    let test = try TestClient(
      token: "signed-token",
      visits: VisitTracker(),
      replies: [
        .failure(URLError(.notConnectedToInternet)),
        try .json(403, ["error": "Complete your profile first."]),
        try screenReply(),
        try screenReply(),
      ]
    )

    for _ in 0..<2 {
      await #expect(throws: APIError.self) { try await test.client.send(.screen(path: "/")) }
    }
    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/"))

    #expect(visitFlags(test) == ["1", "1", "1", nil])
  }

  // Siri and the Shortcuts app read screens without opening the app, so
  // their reads leave the visit for the app's next screen.
  @Test func leavesTheVisitForTheNextReadThatAsksForIt() async throws {
    let test = try TestClient(
      token: "signed-token",
      visits: VisitTracker(),
      replies: [try screenReply(), try screenReply(), try screenReply()]
    )

    _ = try await test.client.send(.screen(path: "/search", visit: .never))
    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/titles/tv/201", visit: .never))

    #expect(visitFlags(test) == [nil, "1", nil])
  }

  @Test func flagsNothingWithoutATracker() async throws {
    let test = try TestClient(token: "signed-token", replies: [try screenReply()])

    _ = try await test.client.send(.screen(path: "/"))

    #expect(visitFlags(test) == [nil])
  }

  @Test func givesTheVisitToOneReadAtATime() {
    let visits = VisitTracker()

    let first = visits.startRead()
    #expect(first != nil)
    #expect(visits.startRead() == nil)
    if let first { visits.finish(first, status: 304) }

    // An unchanged screen's 304 still recorded the visit.
    #expect(visits.startRead() == nil)
  }

  // A read that was in flight when the app left does not use up the visit
  // for the return.
  @Test func keepsTheReturnVisitWhenAnEarlierReadFinishesLate() {
    let visits = VisitTracker()

    let early = visits.startRead()
    visits.sceneChanged(to: .background)
    visits.sceneChanged(to: .active)
    let returned = visits.startRead()
    if let early { visits.finish(early, status: 200) }

    #expect(early != nil)
    #expect(returned != nil)
    #expect(visits.startRead() == nil)
    if let returned { visits.finish(returned, status: nil) }
    #expect(visits.startRead() != nil)
  }
}
