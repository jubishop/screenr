import Foundation
import Testing

@testable import ScreenrKit

@MainActor
struct SessionTests {
  @Test func startsInThePhaseTheKeychainHolds() throws {
    #expect(try SessionStore(keychain: InMemoryKeychain()).phase == .signedOut)
    #expect(try SessionStore(keychain: InMemoryKeychain(token: "signed-token")).phase == .signedIn)
  }

  @Test func storesTheTokenFromAnEmailCodeSignIn() async throws {
    let test = try TestClient(
      replies: [
        try .json(
          200,
          ["token": "unsigned", "user": ["id": "user-pat"]],
          headers: ["set-auth-token": "signed-token"]
        ),
        try .json(200, ["seasons": []]),
      ]
    )

    _ = try await test.client.send(.signIn(email: "pat@example.com", code: "123456"))
    _ = try await test.client.send(.seasons(title: "tv:201"))

    #expect(try test.keychain.read() == "signed-token")
    #expect(test.session.phase == .signedIn)
    let request = try #require(test.transport.requests.first)
    #expect(request.url?.absoluteString == "http://localhost:3000/api/auth/sign-in/email-otp")
    #expect(try request.json == ["email": "pat@example.com", "otp": "123456"])
    #expect(test.header("Authorization", request: 0) == nil)
    #expect(test.header("Origin", request: 0) == nil)
    #expect(test.header("Authorization", request: 1) == "Bearer signed-token")
  }

  @Test func failsASignInWithoutAToken() async throws {
    let test = try TestClient(replies: [try .json(200, ["token": "unsigned"])])

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.signIn(email: "pat@example.com", code: "123456"))
    }

    #expect(error?.kind == .invalidResponse)
    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
  }

  @Test func keepsNoTokenFromAFailedSignIn() async throws {
    let test = try TestClient(
      replies: [
        try .json(400, ["code": "INVALID_OTP", "message": "Invalid OTP"])
      ]
    )

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.signIn(email: "pat@example.com", code: "000000"))
    }

    #expect(error?.kind == .rejected(status: 400))
    #expect(error?.message == "Invalid OTP")
    #expect(try test.keychain.read() == nil)
  }

  @Test func removesTheTokenWhenSigningOut() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["success": true])]
    )

    _ = try await test.client.send(.signOut)

    #expect(test.header("Authorization") == "Bearer signed-token")
    #expect(test.transport.requests.first?.url?.path() == "/api/auth/sign-out")
    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
  }

  @Test func keepsTheTokenWhenSignOutFails() async throws {
    let test = try TestClient(token: "signed-token", replies: [.failure(URLError(.timedOut))])

    await #expect(throws: APIError.self) { try await test.client.send(.signOut) }

    #expect(try test.keychain.read() == "signed-token")
    #expect(test.session.phase == .signedIn)
  }

  @Test func removesTheTokenWhenTheSessionIsGone() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        .response(
          status: 200,
          headers: ["ETag": "W/\"feed-1\""],
          body: try TestFixtures.body("screen/feed/default")
        ),
        try .json(401, ["error": "Sign in to continue."]),
        try .json(401, ["error": "Sign in to continue."]),
      ]
    )

    _ = try await test.client.send(.screen(path: "/"))
    let error = await #expect(throws: APIError.self) {
      try await test.client.send(.screen(path: "/"))
    }
    await #expect(throws: APIError.self) { try await test.client.send(.screen(path: "/")) }

    #expect(error?.kind == .signedOut)
    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
    // The screen cache belonged to the ended session.
    #expect(test.header("Authorization", request: 2) == nil)
    #expect(test.header("If-None-Match", request: 2) == nil)
  }

  @Test func keepsANewerTokenWhenAnOldSessionEnds() throws {
    let keychain = InMemoryKeychain(token: "old-token")
    let session = try SessionStore(keychain: keychain)
    // Another sign-in stored a newer token before the old one's 401 arrived.
    try keychain.write("new-token")

    try session.end(token: "old-token")

    #expect(try keychain.read() == "new-token")
  }

  @Test func ignoresAnUnauthorizedSignInAttempt() async throws {
    let test = try TestClient(
      replies: [try .json(401, ["code": "UNAUTHORIZED", "message": "Invalid token"])]
    )

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(
        .signInWithGoogle(idToken: "id-token", nonce: "nonce-1")
      )
    }

    #expect(error?.kind == .signedOut)
    #expect(error?.message == "Invalid token")
    #expect(test.session.phase == .signedOut)
  }

  @Test func sendsTheInvitationWithEachSignupRequest() async throws {
    let test = try TestClient(
      replies: [
        try .json(200, ["success": true]),
        try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "signed-token"]),
        try .json(200, ["ok": true]),
      ]
    )

    _ = try await test.client.send(.sendCode(email: "pat@example.com", invitation: "invite-1"))
    _ = try await test.client.send(
      .signIn(email: "pat@example.com", code: "123456", invitation: "invite-1")
    )
    _ = try await test.client.send(
      .setup(name: "Pat Morgan", username: "pat", invitation: "invite-1")
    )

    #expect(
      try test.transport.requests.first?.json == ["email": "pat@example.com", "type": "sign-in"]
    )
    for index in 0..<3 {
      #expect(test.header("Screenr-Invitation", request: index) == "invite-1")
    }
    #expect(test.header("Authorization", request: 2) == "Bearer signed-token")
  }

  @Test func signsInWithApple() async throws {
    let test = try TestClient(
      replies: [
        try .json(200, ["redirect": false], headers: ["set-auth-token": "signed-token"])
      ]
    )

    _ = try await test.client.send(
      .signInWithApple(
        identityToken: "identity",
        authorizationCode: "code",
        nonce: "nonce-1",
        name: AppleName(first: "Pat", last: nil)
      )
    )

    #expect(test.transport.requests.first?.url?.path() == "/api/auth/sign-in/social")
    #expect(
      try test.transport.requests.first?.json == [
        "provider": "apple",
        "idToken": [
          "token": "identity", "nonce": "nonce-1", "user": ["name": ["firstName": "Pat"]],
        ],
        "additionalData": ["authorizationCode": "code"],
      ]
    )
    #expect(try test.keychain.read() == "signed-token")
  }
}
