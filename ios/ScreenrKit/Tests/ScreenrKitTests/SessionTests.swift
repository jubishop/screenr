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

  @Test func removesTheTokenAfterDeletingTheAccount() async throws {
    let test = try TestClient(token: "signed-token", replies: [try .json(200, ["ok": true])])

    _ = try await test.client.send(.deleteAccount)

    #expect(test.header("Authorization") == "Bearer signed-token")
    #expect(test.transport.requests.first?.url?.path() == "/api/screenr/delete-account")
    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
    #expect(test.session.ending == .accountDeleted)
  }

  // The sign-in screen says why the last session ended until the next
  // sign-in.
  @Test func remembersHowTheSessionEndedUntilTheNextSignIn() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try .json(200, ["success": true]),
        try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "next-token"]),
      ]
    )
    #expect(test.session.ending == nil)

    _ = try await test.client.send(.signOut)
    #expect(test.session.ending == .signedOut)
    _ = try await test.client.send(.signIn(email: "alice@example.test", code: "123456"))

    #expect(test.session.ending == nil)
  }

  @Test func keepsTheNewTokenWhenASignInConfirmsTheSameMember() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [
        try .json(
          200,
          ["token": "unsigned", "user": ["id": "user-alice"]],
          headers: ["set-auth-token": "fresh-token"]
        )
      ]
    )
    var ended = 0
    test.session.onEnd { _ in ended += 1 }

    _ = try await test.client.send(
      .signIn(email: "alice@example.test", code: "123456", invitation: "invite-1")
        .confirming(userId: "user-alice")
    )

    #expect(try test.keychain.read() == "fresh-token")
    #expect(test.session.phase == .signedIn)
    #expect(ended == 0)
    // Confirming an account never joins one.
    #expect(test.header("Screenr-Invitation") == nil)
  }

  // Sign in with Apple or Google can reach a different account than the one
  // signed in. Confirming the member keeps their session, and ends the other
  // account's new session instead of leaving it behind.
  @Test func keepsTheMembersSessionWhenASignInConfirmsAnotherAccount() async throws {
    let test = try TestClient(
      token: "member-token",
      replies: [
        try .json(
          200,
          ["redirect": false, "token": "unsigned", "user": ["id": "user-ben"]],
          headers: ["set-auth-token": "other-token"]
        ),
        try .json(200, ["success": true]),
      ]
    )
    var ended = 0
    test.session.onEnd { _ in ended += 1 }

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(
        .signInWithGoogle(idToken: "id-token", nonce: "nonce-1").confirming(userId: "user-alice")
      )
    }

    #expect(error?.kind == .otherAccount)
    #expect(
      error?.explanation(otherwise: "")
        == "That sign-in is for a different Screenr account. Use one of this account’s sign-in methods."
    )
    #expect(try test.keychain.read() == "member-token")
    #expect(test.session.phase == .signedIn)
    #expect(ended == 0)
    #expect(
      test.transport.requests.map { $0.url?.path() } == [
        "/api/auth/sign-in/social", "/api/auth/sign-out",
      ]
    )
    #expect(test.header("Authorization", request: 1) == "Bearer other-token")
  }

  // A sign-in that does not say whose it is cannot confirm the member.
  @Test func keepsTheMembersSessionWhenASignInNamesNoOne() async throws {
    let test = try TestClient(
      token: "member-token",
      replies: [
        try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "unknown-token"]),
        try .json(200, ["success": true]),
      ]
    )

    let error = await #expect(throws: APIError.self) {
      try await test.client.send(
        .signIn(email: "alice@example.test", code: "123456").confirming(userId: "user-alice")
      )
    }

    #expect(error?.kind == .invalidResponse)
    #expect(try test.keychain.read() == "member-token")
    #expect(test.header("Authorization", request: 1) == "Bearer unknown-token")
  }

  @Test func keepsTheTokenWhenDeletionNeedsANewSignIn() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try .json(
          403,
          ["error": "To delete your account, confirm it’s you again with a new sign-in."]
        )
      ]
    )

    await #expect(throws: APIError.self) { try await test.client.send(.deleteAccount) }

    #expect(try test.keychain.read() == "signed-token")
    #expect(test.session.phase == .signedIn)
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
    #expect(test.session.ending == .expired)
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
