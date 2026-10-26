import Foundation
import Testing

@testable import ScreenrKit

// Signing out, and what the app forgets when a session ends.
@MainActor
struct SignOutTests {
  private static func feed() throws -> RecordingTransport.Reply {
    .response(
      status: 200,
      headers: ["ETag": "W/\"feed-1\""],
      body: try TestFixtures.body("screen/feed/default")
    )
  }

  @Test func signsOutAndForgetsTheScreens() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try Self.feed(),
        try .json(200, ["success": true]),
        try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "next-token"]),
        try Self.feed(),
      ]
    )
    let model = SignOutModel(api: test.client)

    _ = try await test.client.send(.screen(path: "/"))
    await model.signOut()

    #expect(model.state == .idle)
    #expect(test.session.phase == .signedOut)
    #expect(try test.keychain.read() == nil)
    _ = try await test.client.send(.signIn(email: "alice@example.test", code: "123456"))
    _ = try await test.client.send(.screen(path: "/"))
    // The next member's first read is not answered from the last one's cache.
    #expect(test.header("If-None-Match", request: 3) == nil)
    #expect(test.header("Authorization", request: 3) == "Bearer next-token")
  }

  @Test func keepsTheSessionWhenTheServerDoesNotConfirm() async throws {
    let test = try TestClient(token: "signed-token", replies: [.failure(URLError(.timedOut))])
    let model = SignOutModel(api: test.client)

    await model.signOut()

    #expect(model.state == .failed("Screenr took too long to answer. Try again."))
    #expect(test.session.phase == .signedIn)
    model.dismissFailure()
    #expect(model.state == .idle)
  }

  @Test func treatsAnEndedSessionAsSignedOut() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(401, ["code": "UNAUTHORIZED", "message": "Unauthorized"])]
    )
    let model = SignOutModel(api: test.client)

    await model.signOut()

    #expect(model.state == .idle)
    #expect(test.session.phase == .signedOut)
    // The member chose to leave, though the server had already ended it.
    #expect(test.session.ending == .signedOut)
  }

  @Test func runsTheEndHandlersOnlyWhenTheSessionEnds() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .failure(URLError(.timedOut)),
        try .json(200, ["success": true]),
        try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "next-token"]),
        try .json(401, ["error": "Sign in to continue."]),
      ]
    )
    var endings: [SessionStore.Ending] = []
    test.session.onEnd { endings.append($0) }

    await #expect(throws: APIError.self) { try await test.client.send(.signOut) }
    #expect(endings.isEmpty)
    _ = try await test.client.send(.signOut)
    #expect(endings == [.signedOut])
    _ = try await test.client.send(.signIn(email: "alice@example.test", code: "123456"))
    await #expect(throws: APIError.self) { try await test.client.send(.screen(path: "/")) }
    #expect(endings == [.signedOut, .expired])
  }

  @Test func emptiesTheImageCacheWhenTheSessionEnds() async throws {
    let test = try TestClient(token: "signed-token", replies: [try .json(200, ["success": true])])
    let cache = URLCache(memoryCapacity: 1 << 20, diskCapacity: 0)
    let services = AppServices(
      api: test.client,
      session: test.session,
      identity: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: RecordingTransport([])
        )
      ),
      imageCache: cache
    )
    let url = try #require(URL(string: "http://localhost:3000/api/photos/a"))
    let photo = URLRequest(url: url)
    let response = try #require(
      HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Cache-Control": "private, max-age=3600"]
      )
    )
    cache.storeCachedResponse(CachedURLResponse(response: response, data: Data([1])), for: photo)
    #expect(services.imageCache.cachedResponse(for: photo) != nil)

    _ = try await services.api.send(.signOut)

    #expect(services.imageCache.cachedResponse(for: photo) == nil)
    #expect(services.imageSession.configuration.urlCache === cache)
  }
}
