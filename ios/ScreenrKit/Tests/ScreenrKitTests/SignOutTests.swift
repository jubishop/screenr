import Foundation
import Testing

@testable import ScreenrKit

// Signing out, and what the app forgets when a session ends.
@MainActor
struct SignOutTests {
  private static func feed(etag: String = "W/\"feed-1\"") throws -> RecordingTransport.Reply {
    .response(
      status: 200,
      headers: ["ETag": etag],
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

  // A read can be on its way as the member signs out. Its answer, new or
  // unchanged, belongs to the ended session, so it reaches no one and is not
  // kept.
  @Test(arguments: [200, 304])
  func dropsAReadThatAnswersAfterSigningOut(status: Int) async throws {
    let hold = Hold()
    defer { hold.release() }
    let late: RecordingTransport.Reply =
      status == 304 ? .response(status: 304) : try Self.feed(etag: "W/\"feed-2\"")
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try Self.feed(),
        .held(hold, late),
        try .json(200, ["success": true]),
        try .json(401, ["error": "Sign in to continue."]),
      ]
    )
    _ = try await test.client.send(.screen(path: "/"))
    let read = Task { try await test.client.send(.screen(path: "/")) }
    await hold.arrival()

    _ = try await test.client.send(.signOut)
    hold.release()

    let error = await #expect(throws: APIError.self) { try await read.value }
    #expect(error?.kind == .cancelled)
    await #expect(throws: APIError.self) { try await test.client.send(.screen(path: "/")) }
    #expect(test.header("Authorization", request: 3) == nil)
    #expect(test.header("If-None-Match", request: 3) == nil)
  }

  // The visible screen, such as Settings' account screen, polls as the member
  // signs out. Its late answer brings back nothing of the member: not who is
  // signed in, the user that error reports name, the You tab, or the badge.
  @Test func forgetsTheMemberWhenAScreenAnswersAfterSigningOut() async throws {
    let hold = Hold()
    defer { hold.release() }
    let account: RecordingTransport.Reply = .response(
      status: 200,
      headers: ["ETag": "W/\"account-1\""],
      body: try TestFixtures.body("screen/account/default")
    )
    let test = try TestClient(
      token: "signed-token",
      replies: [try Self.feed(), .held(hold, account), try .json(200, ["success": true])]
    )
    let clock = TestClock()
    var viewers: [String] = []
    let shell = ShellModel(api: test.client, clock: clock) { viewers.append($0.userId) }
    let system = RecordingPushSystem(.allowed)
    let push = PushNotifications(
      api: test.client,
      shell: shell,
      system: system,
      target: PushTarget(
        environment: .sandbox,
        topic: "com.artisanalsoftware.Screenr.dev",
        build: 42
      ),
      session: test.session
    )
    test.session.onEnd { ending in
      shell.sessionEnded(ending)
      push.sessionEnded()
    }
    await shell.checkAccount()
    let screen = try #require(shell.screenModel(for: .account))
    screen.appeared(appActive: true)
    await hold.arrival()

    await SignOutModel(api: test.client).signOut()
    hold.release()
    await clock.waitForSleep(until: .seconds(3))
    await push.badgeUpdate?.value

    #expect(test.session.phase == .signedOut)
    #expect(shell.viewer == nil)
    #expect(shell.router.viewerUsername == nil)
    #expect(shell.unreadNotifications == 0)
    #expect(viewers == ["user-alice"])
    #expect(system.badges == [6, 0])
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
    let services = Self.services(test, imageCache: cache)
    let photo = try Self.cachePhoto(in: cache)
    #expect(services.imageCache.cachedResponse(for: photo) != nil)

    _ = try await services.api.send(.signOut)

    #expect(services.imageCache.cachedResponse(for: photo) == nil)
    #expect(services.imageSession.configuration.urlCache === cache)
  }

  // The session may have ended in an extension, which leaves no token and
  // runs no end handler in the app, so a launch without a session empties
  // the image cache too.
  @Test(arguments: [(nil, false), ("signed-token", true)] as [(String?, Bool)])
  func emptiesTheImageCacheOnALaunchWithoutASession(token: String?, keeps: Bool) throws {
    let test = try TestClient(token: token, replies: [])
    let cache = URLCache(memoryCapacity: 1 << 20, diskCapacity: 0)
    let photo = try Self.cachePhoto(in: cache)

    _ = Self.services(test, imageCache: cache)

    #expect((cache.cachedResponse(for: photo) != nil) == keeps)
  }

  private static func services(_ test: TestClient, imageCache: URLCache) -> AppServices {
    AppServices(
      api: test.client,
      session: test.session,
      identity: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: RecordingTransport([])
        )
      ),
      imageCache: imageCache
    )
  }

  // Keeps a profile photo in `cache`, as loading it would, and returns its
  // request.
  private static func cachePhoto(in cache: URLCache) throws -> URLRequest {
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
    return photo
  }
}
