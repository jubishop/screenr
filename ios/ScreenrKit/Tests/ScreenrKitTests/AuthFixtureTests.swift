import Foundation
import Testing

@testable import ScreenrKit

// Better Auth's recorded answers, as the client reads them: a sign-in names
// the new session's token in `set-auth-token` and the member in `user.id`,
// which a sign-in that confirms the member checks before account deletion.
@MainActor
struct AuthFixtureTests {
  @Test(arguments: ["auth/sign-in/email-otp/default", "auth/sign-in/social/google"])
  func keepsTheRecordedSessionOfTheConfirmedMember(_ fixture: String) async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [try TestFixtures.reply(fixture), try TestFixtures.reply(fixture)]
    )
    let signIn: APIRequest<Acknowledgement> =
      fixture.contains("social")
      ? .signInWithGoogle(idToken: "fixture-google-id-token", nonce: "fixture-nonce")
      : .signIn(email: "alice@example.test", code: "123456")

    _ = try await test.client.send(signIn.confirming(userId: "user-alice"))
    #expect(try test.keychain.read() == FixtureTransport.token)
    try test.keychain.write("earlier-token")
    let other = await #expect(throws: APIError.self) {
      try await test.client.send(signIn.confirming(userId: "user-ben"))
    }

    #expect(other?.kind == .otherAccount)
    #expect(try test.keychain.read() == "earlier-token")
  }

  @Test func signsOutWithTheRecordedAnswer() async throws {
    let test = try TestClient(
      token: FixtureTransport.token,
      replies: [try TestFixtures.reply("auth/sign-out/default")]
    )

    _ = try await test.client.send(.signOut)

    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
  }

  // A sign-out whose session survived on the server keeps it here too, and
  // says so in the server's words.
  @Test func keepsTheSessionWhenTheRecordedSignOutFails() async throws {
    let test = try TestClient(
      token: FixtureTransport.token,
      replies: [try TestFixtures.reply("auth/sign-out/failed")]
    )
    let model = SignOutModel(api: test.client)

    await model.signOut()

    #expect(model.state == .failed("Could not sign out. Try again."))
    #expect(try test.keychain.read() == FixtureTransport.token)
    #expect(test.session.phase == .signedIn)
  }

  // A provider's token that the server rejects keeps the session, and only
  // Better Auth's UNAUTHORIZED, for a request without a session, ends it.
  @Test func endsTheSessionOnlyWhenALinkFindsNone() async throws {
    let test = try TestClient(
      token: FixtureTransport.token,
      replies: [
        try TestFixtures.reply("auth/link-social/invalid-token"),
        try TestFixtures.reply("auth/link-social/signed-out"),
      ]
    )
    let link = APIRequest.linkGoogle(idToken: "fixture-google-id-token", nonce: "fixture-nonce")

    let rejected = await #expect(throws: APIError.self) { try await test.client.send(link) }
    #expect(rejected?.kind == .rejected(status: 401))
    #expect(rejected?.code == "INVALID_TOKEN")
    #expect(try test.keychain.read() == FixtureTransport.token)
    let signedOut = await #expect(throws: APIError.self) { try await test.client.send(link) }

    #expect(signedOut?.kind == .signedOut)
    #expect(try test.keychain.read() == nil)
  }
}
