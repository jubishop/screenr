import Foundation
import ScreenrKit
import Testing

@MainActor
struct ScreenrClientTests {
  @Test func sendsTheClientHeadersAndBearerToken() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [.response(status: 200, body: try TestFixtures.body("screen/feed/default"))]
    )

    _ = try await test.client.send(.screen(path: "/"))

    let request = try #require(test.transport.requests.first)
    #expect(request.url?.absoluteString == "http://localhost:3000/api/screenr/screen?path=%2F")
    #expect(request.httpMethod == "GET")
    #expect(test.header("Authorization") == "Bearer signed-token")
    #expect(test.header("Screenr-Client") == "ios/1.0/7")
    #expect(test.header("Accept") == "application/json")
    let requestID = try #require(test.header("Screenr-Request-Id"))
    #expect(UUID(uuidString: requestID) != nil)
    #expect(test.header("Origin") == nil)
    #expect(test.header("Cookie") == nil)
    #expect(test.header("If-None-Match") == nil)
  }

  @Test func sendsNoTokenWhenSignedOut() async throws {
    let test = try TestClient(replies: [try .json(401, ["error": "Sign in to continue."])])

    await #expect(throws: APIError.self) { try await test.client.send(.screen(path: "/")) }

    #expect(test.header("Authorization") == nil)
    #expect(test.header("Screenr-Client") == "ios/1.0/7")
  }

  @Test func givesEveryRequestItsOwnRequestID() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["ok": true]), try .json(404, ["error": "Comment not found."])]
    )

    _ = try await test.client.send(.removeComment(id: "4"))
    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.removeComment(id: "5"))
    }

    let first = try #require(test.header("Screenr-Request-Id", request: 0))
    let second = try #require(test.header("Screenr-Request-Id", request: 1))
    #expect(first != second)
    #expect(error?.requestID == second)
    #expect(error?.kind == .notFound)
    #expect(error?.message == "Comment not found.")
  }

  @Test func reportsEachRequestToTheObserverWithoutMemberContent() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(status: 200, body: try TestFixtures.body("screen/profile/friend")),
        .failure(URLError(.notConnectedToInternet)),
      ]
    )

    _ = try await test.client.send(.screen(path: "/people/ben"))
    await #expect(throws: APIError.self) { try await test.client.send(.search("night")) }

    let records = test.observer.records
    #expect(
      records.map(\.route) == ["/api/screenr/screen?path=/people/:username", "/api/screenr/search"]
    )
    #expect(records.map(\.method) == ["GET", "GET"])
    #expect(records.map(\.status) == [200, nil])
    #expect(records[0].requestID == test.header("Screenr-Request-Id", request: 0))
    #expect(records[0].error == nil)
    #expect(records[1].error?.kind == .offline)
    #expect(records[1].error?.requestID == test.header("Screenr-Request-Id", request: 1))
  }

  @Test func postsJSONBodies() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["id": "10"])]
    )

    let created = try await test.client.send(
      .comment(conversation: "entry-1", body: "Adding it to my list.", spoiler: false, replyTo: "2")
    )

    #expect(created.id == "10")
    let request = try #require(test.transport.requests.first)
    #expect(request.url?.path() == "/api/screenr/comment")
    #expect(request.httpMethod == "POST")
    #expect(test.header("Content-Type") == "application/json")
    #expect(
      try request.json == [
        "conversation": "entry-1", "body": "Adding it to my list.", "spoiler": false,
        "replyTo": "2",
      ]
    )
  }

  @Test func uploadsPhotosAsTheRawBody() async throws {
    let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["photo": "6b8351fef1a68536"])]
    )

    let version = try await test.client.send(.uploadPhoto(jpeg: jpeg))

    #expect(version.photo == "6b8351fef1a68536")
    #expect(test.header("Content-Type") == "image/jpeg")
    #expect(test.transport.requests.first?.httpBody == jpeg)
  }

  @Test func encodesEveryReservedCharacterInScreenPaths() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [.response(status: 200, body: try TestFixtures.body("screen/feed/linked-reply"))]
    )

    _ = try await test.client.send(.screen(path: "/?item=a b+c&reply=8"))

    #expect(
      test.transport.requests.first?.url?.absoluteString
        == "http://localhost:3000/api/screenr/screen?path=%2F%3Fitem%3Da%20b%2Bc%26reply%3D8"
    )
  }

  @Test func reusesTheCachedScreenWhenTheServerSaysItIsUnchanged() async throws {
    let etag = "W/\"version-1\""
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(
          status: 200,
          headers: ["ETag": etag],
          body: try TestFixtures.body("screen/feed/default")
        ),
        .response(status: 304, headers: ["ETag": etag]),
      ]
    )

    let first = try await test.client.send(.screen(path: "/"))
    let second = try await test.client.send(.screen(path: "/"))

    #expect(test.header("If-None-Match", request: 0) == nil)
    #expect(test.header("If-None-Match", request: 1) == etag)
    #expect(second == first)
    guard case .feed(let feed) = second.content else {
      Issue.record("Expected the feed, not \(second.content)")
      return
    }
    #expect(!feed.conversations.isEmpty)
  }

  @Test func keepsOneCachedVersionForEachPath() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(
          status: 200,
          headers: ["ETag": "W/\"feed-1\""],
          body: try TestFixtures.body("screen/feed/default")
        ),
        .response(
          status: 200,
          headers: ["ETag": "W/\"people-1\""],
          body: try TestFixtures.body("screen/people/default")
        ),
        .response(
          status: 200,
          headers: ["ETag": "W/\"feed-2\""],
          body: try TestFixtures.body("screen/feed/empty")
        ),
        .response(status: 304, headers: ["ETag": "W/\"feed-2\""]),
      ]
    )

    _ = try await test.client.send(.screen(path: "/"))
    _ = try await test.client.send(.screen(path: "/people"))
    _ = try await test.client.send(.screen(path: "/"))
    let unchanged = try await test.client.send(.screen(path: "/"))

    #expect(test.header("If-None-Match", request: 1) == nil)
    #expect(test.header("If-None-Match", request: 2) == "W/\"feed-1\"")
    #expect(test.header("If-None-Match", request: 3) == "W/\"feed-2\"")
    guard case .feed(let feed) = unchanged.content else {
      Issue.record("Expected the feed, not \(unchanged.content)")
      return
    }
    #expect(feed.conversations.isEmpty)
  }

  @Test func requiresAnUpdateWhenTheServerAnswers426() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(426, ["error": "Update Screenr to continue.", "minimumBuild": 42])]
    )
    #expect(test.session.phase == .signedIn)

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.screen(path: "/"))
    }

    #expect(error?.kind == .updateRequired(minimumBuild: 42))
    #expect(error?.message == "Update Screenr to continue.")
    #expect(error?.isPermanent == true)
    #expect(test.session.phase == .updateRequired(minimumBuild: 42))
    #expect(try test.keychain.read() == "signed-token")
  }

  @Test(arguments: [
    (400, APIError.Kind.rejected(status: 400)),
    (401, .signedOut),
    (403, .forbidden),
    (404, .notFound),
    (408, .timedOut),
    (413, .rejected(status: 413)),
    (429, .rateLimited),
    (500, .server(status: 500)),
    (503, .server(status: 503)),
  ])
  func mapsErrorStatuses(status: Int, kind: APIError.Kind) async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(status, ["error": "Something went wrong."])]
    )

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.removeReview(title: "movie:102"))
    }

    #expect(error?.kind == kind)
    #expect(error?.message == "Something went wrong.")
  }

  @Test(arguments: [
    (URLError.Code.timedOut, APIError.Kind.timedOut),
    (.notConnectedToInternet, .offline),
    (.cannotConnectToHost, .offline),
    (.cancelled, .cancelled),
  ])
  func mapsTransportFailures(code: URLError.Code, kind: APIError.Kind) async throws {
    let test = try TestClient(token: "signed-token", replies: [.failure(URLError(code))])

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.screen(path: "/"))
    }

    #expect(error?.kind == kind)
    #expect(error?.requestID == test.header("Screenr-Request-Id"))
  }

  @Test func rejectsAnUnreadableResponse() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [.response(status: 200, body: Data("<html>Bad gateway</html>".utf8))]
    )

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.screen(path: "/"))
    }

    #expect(error?.kind == .invalidResponse)
    #expect(error?.isPermanent == false)
  }

  @Test func readsAnErrorWithoutABody() async throws {
    let test = try TestClient(token: "signed-token", replies: [.response(status: 502)])

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.screen(path: "/"))
    }

    #expect(error?.kind == .server(status: 502))
    #expect(error?.message == nil)
  }
}
