import AuthenticationServices
import Foundation
import Testing

@testable import ScreenrKit

// The sign-in screen's model, against the real client and canned replies.
@MainActor
struct SignInModelTests {
  static let codeLimit = "Too many codes requested. Try again later, or continue with Google."

  private func model(
    _ test: TestClient,
    invitation: String? = nil,
    google: RecordingTransport = RecordingTransport([])
  ) -> SignInModel {
    SignInModel(
      api: test.client,
      invitation: PendingInvitation(token: invitation),
      providers: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(clientID: GoogleSignInTests.clientID, transport: google)
      )
    )
  }

  private static func signedIn() throws -> RecordingTransport.Reply {
    try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "signed-token"])
  }

  @Test func requestsACodeAndSignsInWithIt() async throws {
    let test = try TestClient(replies: [try .json(200, ["success": true]), try Self.signedIn()])
    let model = model(test, invitation: "invite-1")
    model.email = " pat@example.com "

    await model.sendCode()
    model.enterCode("12 34-56 7")
    await model.checkCode()

    #expect(model.step == .code(email: "pat@example.com"))
    #expect(model.code == "123456")
    #expect(model.failure == nil)
    #expect(model.activity == .idle)
    #expect(test.session.phase == .signedIn)
    #expect(try test.keychain.read() == "signed-token")
    let requests = test.transport.requests
    #expect(
      requests.map { $0.url?.path() } == [
        "/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp",
      ]
    )
    #expect(try requests[0].json == ["email": "pat@example.com", "type": "sign-in"])
    #expect(try requests[1].json == ["email": "pat@example.com", "otp": "123456"])
    #expect(test.header("Screenr-Invitation", request: 0) == "invite-1")
    #expect(test.header("Screenr-Invitation", request: 1) == "invite-1")
  }

  @Test func saysWhenTheInvitationCannotBeUsed() async throws {
    let test = try TestClient(replies: [try .json(200, ["available": false])])
    let invitation = PendingInvitation(storage: InMemoryKeychain())
    invitation.open("used-up-link")
    let model = SignInModel(
      api: test.client,
      invitation: invitation,
      providers: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: RecordingTransport([])
        )
      )
    )
    #expect(model.isInvited)
    #expect(model.invitationNotice == nil)

    await invitation.check(using: test.client)

    #expect(!model.isInvited)
    #expect(
      model.invitationNotice
        == "That invitation is no longer available. Existing members can still sign in."
    )
  }

  @Test func waitsForAnAddressAndSixDigits() async throws {
    let test = try TestClient(replies: [try .json(200, ["success": true])])
    let model = model(test)

    for address in ["", "pat", "pat@", "@example.com", "pat @example.com", "a@b@c"] {
      model.email = address
      #expect(!model.canSendCode, "\(address)")
    }
    await model.sendCode()
    #expect(test.transport.requests.isEmpty)

    model.email = "pat@example.com"
    #expect(model.canSendCode)
    await model.sendCode()
    model.enterCode("12345")
    #expect(!model.canCheckCode)
    await model.checkCode()
    #expect(test.transport.requests.count == 1)
    model.enterCode("123456")
    #expect(model.canCheckCode)
  }

  @Test(arguments: [
    "auth/email-otp/send-verification-otp/rate-limited",
    "auth/email-otp/send-verification-otp/too-many-requests",
  ])
  func showsTheServersCodeRequestLimit(fixture: String) async throws {
    let test = try TestClient(
      replies: [.response(status: 429, body: try TestFixtures.body(fixture))]
    )
    let model = model(test)
    model.email = "alice@example.test"

    await model.sendCode()

    let expected =
      fixture.hasSuffix("rate-limited")
      ? Self.codeLimit : "Too many requests. Please try again later."
    #expect(model.failure == expected)
    #expect(model.step == .email)
  }

  @Test func showsTheServersAttemptLimitAndAllowsANewCode() async throws {
    let test = try TestClient(
      replies: [
        try .json(200, ["success": true]),
        .response(
          status: 403,
          body: try TestFixtures.body("auth/sign-in/email-otp/too-many-attempts")
        ),
      ]
    )
    let model = model(test)
    model.email = "alice@example.test"

    await model.sendCode()
    model.enterCode("000000")
    await model.checkCode()

    #expect(model.failure == "Too many attempts")
    #expect(test.session.phase == .signedOut)
    #expect(model.step == .code(email: "alice@example.test"))

    model.useAnotherEmail()

    #expect(model.step == .email)
    #expect(model.email == "alice@example.test")
    #expect(model.code.isEmpty)
    #expect(model.failure == nil)
  }

  @Test func showsTheServersWordsForAWrongCode() async throws {
    let test = try TestClient(
      replies: [
        try .json(200, ["success": true]),
        .response(status: 400, body: try TestFixtures.body("auth/sign-in/email-otp/invalid-code")),
      ]
    )
    let model = model(test)
    model.email = "alice@example.test"

    await model.sendCode()
    model.enterCode("000000")
    await model.checkCode()

    #expect(model.failure == "Invalid OTP")
  }

  @Test func explainsAFailureWithoutAServerMessage() async throws {
    let test = try TestClient(replies: [.failure(URLError(.notConnectedToInternet))])
    let model = model(test)
    model.email = "pat@example.com"

    await model.sendCode()

    #expect(model.failure == "You’re offline. Check your connection and try again.")
  }

  @Test func signsInWithAppleUsingTheRawNonce() async throws {
    let test = try TestClient(replies: [try Self.signedIn()])
    let model = model(test, invitation: "invite-1")

    let hashed = model.startApple()
    await model.signInWithApple(
      AppleCredential(
        identityToken: "identity",
        authorizationCode: "code",
        name: AppleName(first: "Pat", last: nil)
      )
    )

    #expect(test.session.phase == .signedIn)
    #expect(model.failure == nil)
    let request = try #require(test.transport.requests.first)
    guard case .object(let body)? = try request.json, case .object(let idToken)? = body["idToken"],
      case .string(let nonce)? = idToken["nonce"]
    else {
      Issue.record("Expected an ID token with a nonce")
      return
    }
    #expect(AppleNonce(raw: nonce).hashed == hashed)
    #expect(
      try request.json == [
        "provider": "apple",
        "idToken": [
          "token": "identity", "nonce": .string(nonce),
          "user": ["name": ["firstName": "Pat"]],
        ],
        "additionalData": ["authorizationCode": "code"],
      ]
    )
    #expect(test.header("Screenr-Invitation") == "invite-1")
  }

  @Test func needsTheAppleRequestsNonce() async throws {
    let test = try TestClient(replies: [])
    let model = model(test)
    let credential = AppleCredential(
      identityToken: "identity",
      authorizationCode: "code",
      name: nil
    )

    await model.signInWithApple(credential)
    _ = model.startApple()
    await model.completeApple(.failure(ASAuthorizationError(.failed)))
    await model.signInWithApple(credential)

    #expect(test.transport.requests.isEmpty)
    #expect(model.failure == "Sign in with Apple did not finish. Try again.")
  }

  @Test func saysNothingWhenTheAppleSheetIsCancelled() async throws {
    let test = try TestClient(replies: [])
    let model = model(test)

    _ = model.startApple()
    await model.completeApple(.failure(ASAuthorizationError(.canceled)))

    #expect(model.failure == nil)
    #expect(test.transport.requests.isEmpty)
  }

  @Test(
    arguments: [
      (
        401, ["code": "OAUTH_LINK_ERROR", "message": "Account not linked"],
        "That email address already has a Screenr account. Sign in with an email code, then connect Apple in your account settings."
      ),
      (
        401, ["code": "INVALID_TOKEN", "message": "Invalid token"],
        "Screenr could not confirm your Apple sign-in. Try again."
      ),
      (
        404, ["code": "PROVIDER_NOT_FOUND", "message": "Provider not found"],
        "Apple sign-in is unavailable right now. Use an email code instead."
      ),
      (
        403, ["message": "A valid invitation is required to join Screenr."],
        "A valid invitation is required to join Screenr."
      ),
      (
        503, ["message": "Sign in with Apple is unavailable right now. Try again later."],
        "Sign in with Apple is unavailable right now. Try again later."
      ),
    ] as [(Int, JSONValue, String)]
  )
  func explainsAppleRejections(status: Int, body: JSONValue, message: String) async throws {
    let test = try TestClient(replies: [try .json(status, body)])
    let model = model(test)

    _ = model.startApple()
    await model.signInWithApple(
      AppleCredential(identityToken: "identity", authorizationCode: "code", name: nil)
    )

    #expect(model.failure == message)
    #expect(test.session.phase == .signedOut)
  }

  @Test func signsInWithGoogleUsingTheNonceGoogleSigned() async throws {
    let test = try TestClient(replies: [try Self.signedIn()])
    let google = RecordingTransport([try .json(200, ["id_token": "google-id-token"])])
    let model = model(test, invitation: "invite-1", google: google)
    let authenticator = RedirectingAuthenticator()

    await model.signInWithGoogle(using: authenticator)

    #expect(model.failure == nil)
    #expect(test.session.phase == .signedIn)
    let opened = try #require(authenticator.opened)
    var nonce = ""
    for item in URLComponents(url: opened.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    where item.name == "nonce" {
      nonce = item.value ?? ""
    }
    #expect(
      try test.transport.requests.first?.json == [
        "provider": "google", "idToken": ["token": "google-id-token", "nonce": .string(nonce)],
      ]
    )
    #expect(test.header("Screenr-Invitation") == "invite-1")
  }

  @Test func saysNothingWhenTheGoogleSheetIsCancelled() async throws {
    let test = try TestClient(replies: [])
    let model = model(test)

    await model.signInWithGoogle(
      using: FailingAuthenticator(error: ASWebAuthenticationSessionError(.canceledLogin))
    )

    #expect(model.failure == nil)
    #expect(model.activity == .idle)
    #expect(test.transport.requests.isEmpty)
  }

  @Test func explainsAGoogleFailure() async throws {
    let test = try TestClient(replies: [try .json(401, ["code": "OAUTH_LINK_ERROR"])])
    let rejected = RecordingTransport([try .json(400, ["error": "invalid_grant"])])
    let accepted = RecordingTransport([try .json(200, ["id_token": "google-id-token"])])

    let unredeemed = model(test, google: rejected)
    await unredeemed.signInWithGoogle(using: RedirectingAuthenticator())
    let unlinked = model(test, google: accepted)
    await unlinked.signInWithGoogle(using: RedirectingAuthenticator())

    #expect(unredeemed.failure == "Google sign-in did not finish. Try again.")
    #expect(
      unlinked.failure
        == "That email address already has a Screenr account. Sign in with an email code, then connect Google in your account settings."
    )
  }
}
