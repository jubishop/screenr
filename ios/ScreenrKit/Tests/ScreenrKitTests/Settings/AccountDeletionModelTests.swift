import Foundation
import Testing

@testable import ScreenrKit

// Deleting the account from Settings: confirming it's the member with a new
// sign-in, then deleting, against canned replies and the fixture API.
@MainActor
struct AccountDeletionModelTests {
  static let alice = MemberConfirmation(
    userId: "user-alice",
    email: "alice@example.test",
    methods: [.google, .emailCode]
  )
  static let staleSignIn = "To delete your account, confirm it’s you again with a new sign-in."
  static let appleUnavailable =
    "Sign in with Apple could not be disconnected, so your account was not deleted. Please try again later."

  private func providers(
    google: RecordingTransport = RecordingTransport([])
  ) -> IdentityProviders {
    IdentityProviders(
      authorization: .system,
      google: GoogleSignIn(clientID: GoogleSignInTests.clientID, transport: google)
    )
  }

  private func deletion(_ test: TestClient) -> AccountDeletionModel {
    AccountDeletionModel(api: test.client, member: Self.alice, providers: providers())
  }

  private static func codeSent() throws -> RecordingTransport.Reply {
    try .json(200, ["success": true])
  }

  private static func signedIn(as userId: String = "user-alice") throws -> RecordingTransport.Reply
  {
    try .json(
      200,
      ["token": "unsigned", "user": ["id": .string(userId)]],
      headers: ["set-auth-token": "fresh-token"]
    )
  }

  // Confirms with an email code, as the member would.
  private func confirm(_ deletion: AccountDeletionModel) async {
    await deletion.signIn.sendCode()
    deletion.signIn.enterCode("123456")
    await deletion.signIn.checkCode()
  }

  @Test func takesTheMethodsConnectedToTheAccount() throws {
    let page = try AccountScreenFixture.page
    let viewer = Person(userId: "user-alice", username: "alice", displayName: "Alice", photo: nil)

    let member = MemberConfirmation(account: page, viewer: viewer)

    #expect(member.userId == "user-alice")
    #expect(member.email == "alice@example.test")
    // Google is connected; Apple is offered but not connected.
    #expect(member.methods == [.google, .emailCode])
  }

  @Test func confirmsTheMemberWithACodeToTheirOwnAddress() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [try Self.codeSent(), try Self.signedIn()]
    )
    let deletion = deletion(test)
    let signIn = deletion.signIn
    #expect(deletion.step == .verify)
    #expect(signIn.methods == [.google, .emailCode])
    #expect(signIn.fixedEmail == "alice@example.test")
    #expect(!signIn.isInvited)

    // Only the account's own address gets the code.
    signIn.email = "someone@example.test"
    await confirm(deletion)

    #expect(deletion.step == .confirm)
    #expect(deletion.failure == nil)
    #expect(signIn.failure == nil)
    #expect(try test.keychain.read() == "fresh-token")
    let requests = test.transport.requests
    #expect(try requests[0].json == ["email": "alice@example.test", "type": "sign-in"])
    #expect(try requests[1].json == ["email": "alice@example.test", "otp": "123456"])
    #expect(test.header("Screenr-Invitation", request: 0) == nil)
    #expect(test.header("Screenr-Invitation", request: 1) == nil)
  }

  @Test func staysUnconfirmedWhenTheSignInIsAnotherAccount() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [try Self.codeSent(), try Self.signedIn(as: "user-ben"), try .json(200, [:])]
    )
    let deletion = deletion(test)

    await confirm(deletion)

    #expect(deletion.step == .verify)
    #expect(
      deletion.signIn.failure
        == "That sign-in is for a different Screenr account. Use one of this account’s sign-in methods."
    )
    #expect(try test.keychain.read() == "earlier-token")
  }

  @Test func explainsAGoogleAccountThatIsNotThisOne() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [try .json(403, ["message": "A valid invitation is required to join Screenr."])]
    )
    let google = RecordingTransport([try .json(200, ["id_token": "google-id-token"])])
    let deletion = AccountDeletionModel(
      api: test.client,
      member: Self.alice,
      providers: providers(google: google)
    )

    await deletion.signIn.signInWithGoogle(using: RedirectingAuthenticator())

    #expect(deletion.step == .verify)
    #expect(
      deletion.signIn.failure
        == "That Google account isn’t connected to this Screenr account. Use an email code instead."
    )
  }

  @Test func deletesTheAccountOnceConfirmed() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [try Self.codeSent(), try Self.signedIn(), try .json(200, ["ok": true])]
    )
    let deletion = deletion(test)

    // Nothing is deleted before the member confirms it's them.
    await deletion.delete()
    #expect(test.transport.requests.isEmpty)
    await confirm(deletion)
    await deletion.delete()

    #expect(deletion.step == .deleted)
    #expect(deletion.failure == nil)
    #expect(test.transport.requests.last?.url?.path() == "/api/screenr/delete-account")
    #expect(test.header("Authorization", request: 2) == "Bearer fresh-token")
    #expect(try test.keychain.read() == nil)
    #expect(test.session.phase == .signedOut)
    #expect(test.session.ending == .accountDeleted)
  }

  // More than ten minutes after the new sign-in, the server asks for another.
  @Test func asksForANewSignInWhenTheLastIsTooOld() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [
        try Self.codeSent(), try Self.signedIn(),
        .response(
          status: 403,
          body: try TestFixtures.body("actions/delete-account/stale-sign-in")
        ),
        try Self.codeSent(), try Self.signedIn(),
      ]
    )
    let deletion = deletion(test)
    await confirm(deletion)

    await deletion.delete()

    #expect(deletion.step == .verify)
    #expect(deletion.failure == Self.staleSignIn)
    #expect(deletion.signIn.step == .email)
    #expect(deletion.signIn.code.isEmpty)
    #expect(test.session.phase == .signedIn)
    await confirm(deletion)
    #expect(deletion.step == .confirm)
    #expect(deletion.failure == nil)
  }

  // Sign in with Apple could not be disconnected, so nothing was deleted and
  // the member can try again.
  @Test func offersAnotherTryWhenAppleCannotBeDisconnected() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [
        try Self.codeSent(), try Self.signedIn(),
        .response(
          status: 503,
          body: try TestFixtures.body("actions/delete-account/apple-unavailable")
        ),
        try .json(200, ["ok": true]),
      ]
    )
    let deletion = deletion(test)
    await confirm(deletion)

    await deletion.delete()

    #expect(deletion.step == .confirm)
    #expect(deletion.failure == Self.appleUnavailable)
    #expect(test.session.phase == .signedIn)
    await deletion.delete()
    #expect(deletion.step == .deleted)
    #expect(deletion.failure == nil)
  }

  @Test func explainsAFailureWithoutAServerMessage() async throws {
    let test = try TestClient(
      token: "earlier-token",
      replies: [
        try Self.codeSent(), try Self.signedIn(), .failure(URLError(.notConnectedToInternet)),
      ]
    )
    let deletion = deletion(test)
    await confirm(deletion)

    await deletion.delete()

    #expect(deletion.step == .confirm)
    #expect(deletion.failure == "You’re offline. Check your connection and try again.")
  }

  // Deleting the account leaves nothing in the Keychain: the session token,
  // and any invitation link kept for joining, which signing out keeps.
  @Test func forgetsAKeptInvitationOnlyWhenTheAccountIsDeleted() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try .json(200, ["success": true]), try Self.signedIn(), try .json(200, ["ok": true]),
      ]
    )
    let invitation = PendingInvitation(token: "invite-1")
    let services = AppServices(
      api: test.client,
      session: test.session,
      invitation: invitation,
      identity: providers()
    )

    _ = try await services.api.send(.signOut)
    #expect(invitation.token == "invite-1")
    _ = try await services.api.send(.signIn(email: "alice@example.test", code: "123456"))
    _ = try await services.api.send(.deleteAccount)

    #expect(invitation.token == nil)
    #expect(invitation.status == .none)
  }

  // The journey the UI tests take: the fixture API's account screen and
  // Google stand-in, then deletion, which ends the session.
  @Test func confirmsAndDeletesThroughTheFixtureAPI() async throws {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": GoogleSignInTests.clientID,
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
    let services = try AppServices(
      configuration: configuration,
      arguments: ["Screenr", "-ScreenrFixtures", TestFixtures.directory.path()]
    )
    let screen = try await services.api.send(.screen(path: "/account"))
    guard case .account(let page) = screen.content else {
      Issue.record("Expected the account screen")
      return
    }
    let deletion = AccountDeletionModel(
      api: services.api,
      member: MemberConfirmation(account: page, viewer: screen.user),
      providers: services.identity
    )

    await deletion.signIn.signInWithGoogle(using: FixtureWebAuthenticator())
    #expect(deletion.step == .confirm)
    await deletion.delete()

    #expect(deletion.step == .deleted)
    #expect(services.session.phase == .signedOut)
    #expect(services.session.ending == .accountDeleted)
  }
}

// The fixture API's account screen for Alice.
enum AccountScreenFixture {
  static var page: AccountScreen {
    get throws {
      let data = try TestFixtures.body("screen/account/default")
      let screen = try ScreenrJSON.decoder().decode(Screen.self, from: data)
      guard case .account(let page) = screen.content else {
        throw FixtureError("screen/account/default is not an account screen")
      }
      return page
    }
  }
}
