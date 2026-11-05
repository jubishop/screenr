import Foundation
import Testing

@testable import ScreenrKit

// The client keeps the reads it used most recently, so revisiting a screen
// costs a 304, but never more than 32 of them or 8 MB of their bodies, and
// none once the system warns that memory is low.
@MainActor
struct ResponseCacheTests {
  private static func photo(_ index: Int) -> APIRequest<Data> {
    .photo(userId: "user-\(index)", version: "v1")
  }

  private static func etag(_ index: Int) -> String { "\"photo-\(index)\"" }

  private static func fresh(_ index: Int, bytes: Int = 4) -> RecordingTransport.Reply {
    .response(status: 200, headers: ["ETag": etag(index)], body: Data(count: bytes))
  }

  private static func unchanged(_ index: Int) -> RecordingTransport.Reply {
    .response(status: 304, headers: ["ETag": etag(index)])
  }

  @Test func forgetsTheLeastRecentlyUsedReadPastThirtyTwo() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: (0..<32).map { Self.fresh($0) } + [
        Self.unchanged(0), Self.fresh(32), Self.fresh(1), Self.unchanged(0),
      ]
    )

    for index in 0..<32 { _ = try await test.client.send(Self.photo(index)) }
    // Reading the first again makes it the most recent, so the second is the
    // one that goes when a 33rd arrives.
    _ = try await test.client.send(Self.photo(0))
    _ = try await test.client.send(Self.photo(32))
    _ = try await test.client.send(Self.photo(1))
    _ = try await test.client.send(Self.photo(0))

    #expect(test.header("If-None-Match", request: 32) == Self.etag(0))
    #expect(test.header("If-None-Match", request: 34) == nil)
    #expect(test.header("If-None-Match", request: 35) == Self.etag(0))
  }

  @Test func forgetsTheOldestReadsPastEightMegabytes() async throws {
    let large = 3 << 20
    let test = try TestClient(
      token: "signed-token",
      replies: [
        Self.fresh(0, bytes: large), Self.fresh(1, bytes: large), Self.fresh(2, bytes: large),
        Self.fresh(0, bytes: large), Self.unchanged(2),
      ]
    )

    for index in [0, 1, 2, 0, 2] { _ = try await test.client.send(Self.photo(index)) }

    // The third photo passed 8 MB, so the first went.
    #expect(test.header("If-None-Match", request: 3) == nil)
    #expect(test.header("If-None-Match", request: 4) == Self.etag(2))
  }

  @Test func keepsTheNewestReadEvenPastTheLimit() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [Self.fresh(0, bytes: 9 << 20), Self.unchanged(0)]
    )

    let first = try await test.client.send(Self.photo(0))
    let again = try await test.client.send(Self.photo(0))

    #expect(test.header("If-None-Match", request: 1) == Self.etag(0))
    #expect(again == first)
  }

  @Test func forgetsEveryReadWhenMemoryRunsLow() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [Self.fresh(0), Self.fresh(1), Self.fresh(0), Self.unchanged(1)]
    )
    _ = try await test.client.send(Self.photo(0))

    test.notifications.post(name: .memoryWarning, object: nil)
    _ = try await test.client.send(Self.photo(1))
    _ = try await test.client.send(Self.photo(0))
    _ = try await test.client.send(Self.photo(1))

    #expect(test.header("If-None-Match", request: 2) == nil)
    // Reads after the warning are kept again.
    #expect(test.header("If-None-Match", request: 3) == Self.etag(1))
  }
}
