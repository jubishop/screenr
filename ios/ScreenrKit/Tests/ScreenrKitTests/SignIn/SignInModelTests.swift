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
    google: RecordingTransport = RecordingTransport([]),
    log: Log = Log(.session, router: LogRouter())
  ) -> SignInModel {
    SignInModel(
      api: test.client,
      invitation: PendingInvitation(token: invitation),
      providers: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(clientID: GoogleSignInTests.clientID, transport: google),
        log: log
      ),
      browser: FailingAuthenticator(error: URLError(.badURL))
    )
  }

  private static func signedIn() throws -> RecordingTransport.Reply {
    try .json(200, ["token": "unsigned"], headers: ["set-auth-token": "signed-token"])
  }

  static let pickupMissed =
    "Screenr couldn’t find your invitation. If you’re new, tap your invitation link again to open it here."

  // A model whose pickup asks `safari` for the invitation a link saved.
  private func pickupModel(
    _ test: TestClient,
    safari: PickupAuthenticator,
    members: InMemoryKeychain = InMemoryKeychain(),
    google: RecordingTransport = RecordingTransport([])
  ) throws -> (SignInModel, InvitationPickup) {
    let pickup = try InvitationPickupTests.pickup(members: members)
    let model = SignInModel(
      api: test.client,
      invitation: PendingInvitation(storage: InMemoryKeychain()),
      providers: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(clientID: GoogleSignInTests.clientID, transport: google),
        pickup: pickup
      ),
      browser: safari
    )
    return (model, pickup)
  }

  @Test func picksUpTheInvitationSafariSavedBeforeTheFirstSignIn() async throws {
    let test = try TestClient(replies: [try .json(200, ["success": true]), try Self.signedIn()])
    let safari = PickupAuthenticator(.token(InvitationPickupTests.token))
    let members = InMemoryKeychain()
    let (model, pickup) = try pickupModel(test, safari: safari, members: members)
    model.email = "pat@example.com"
    #expect(!model.isInvited)

    await model.sendCode()
    model.enterCode("123456")
    await model.checkCode()

    #expect(model.isInvited)
    #expect(model.invitationNotice == nil)
    #expect(test.header("Screenr-Invitation", request: 0) == InvitationPickupTests.token)
    #expect(test.header("Screenr-Invitation", request: 1) == InvitationPickupTests.token)
    #expect(test.session.phase == .signedIn)
    // A member signed in, so the app never asks Safari on this iPhone again.
    #expect(safari.opened.count == 1)
    #expect(pickup.phase == .done)
    #expect(try members.read() == InvitationPickup.memberMark)
  }

  @Test func asksForTheLinkAgainWhenNoInvitationTurnsUp() async throws {
    let test = try TestClient(replies: [
      try .json(200, ["success": true]), try .json(200, ["success": true]),
    ])
    let safari = PickupAuthenticator(.error(ASWebAuthenticationSessionError(.canceledLogin)))
    let (model, pickup) = try pickupModel(test, safari: safari)
    model.email = "new@example.com"

    await model.sendCode()

    // The sign-in goes on, since an existing member needs no invitation.
    #expect(model.step == .code(email: "new@example.com"))
    #expect(test.header("Screenr-Invitation") == nil)
    #expect(pickup.phase == .missed)
    #expect(model.invitationNotice == Self.pickupMissed)
    // It asks once a launch.
    model.useAnotherEmail()
    await model.sendCode()
    #expect(safari.opened.count == 1)
    #expect(test.transport.requests.count == 2)
  }

  @Test func picksUpTheInvitationBeforeAppleAndGoogleSignIns() async throws {
    let apple = try TestClient(replies: [try Self.signedIn()])
    let appleSafari = PickupAuthenticator(.token(InvitationPickupTests.token))
    let (appleModel, _) = try pickupModel(apple, safari: appleSafari)
    _ = appleModel.startApple()
    await appleModel.signInWithApple(
      AppleCredential(identityToken: "identity", authorizationCode: "code", name: nil)
    )
    #expect(appleSafari.opened.count == 1)
    #expect(apple.header("Screenr-Invitation") == InvitationPickupTests.token)

    let google = try TestClient(replies: [try Self.signedIn()])
    let googleSafari = PickupAuthenticator(.token(InvitationPickupTests.token))
    let (googleModel, _) = try pickupModel(
      google,
      safari: googleSafari,
      google: RecordingTransport([try .json(200, ["id_token": "google-id-token"])])
    )
    let googlePage = RedirectingAuthenticator()
    await googleModel.signInWithGoogle(using: googlePage)
    #expect(googleSafari.opened.count == 1)
    #expect(googlePage.opened != nil)
    #expect(google.header("Screenr-Invitation") == InvitationPickupTests.token)
  }

  @Test func confirmingTheMemberNeverPicksUpAnInvitation() async throws {
    let test = try TestClient(replies: [try .json(200, ["success": true])])
    let pickup = try InvitationPickupTests.pickup()
    let model = SignInModel(
      api: test.client,
      confirming: MemberConfirmation(userId: "u1", email: "pat@example.com", methods: [.emailCode]),
      providers: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: RecordingTransport([])
        ),
        pickup: pickup
      )
    )

    await model.sendCode()

    #expect(pickup.phase == .due)
    #expect(model.invitationNotice == nil)
    #expect(test.transport.requests.count == 1)
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
      ),
      browser: FailingAuthenticator(error: URLError(.badURL))
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

  // Apple's sheet failing logs a warning with the error's domain and code, which name its case.
  // Cancelling it logs nothing.
  @Test func logsAFailedAppleSheetButNotACancelledOne() async throws {
    let router = LogRouter()
    let sink = CapturingSink()
    router.add(sink)
    let test = try TestClient(replies: [])
    let model = model(test, log: Log(.session, router: router))

    _ = model.startApple()
    await model.completeApple(.failure(ASAuthorizationError(.canceled)))
    _ = model.startApple()
    await model.completeApple(.failure(ASAuthorizationError(.failed)))

    let line = try #require(sink.entries.only)
    #expect(line.level == .warning)
    #expect(line.category == .session)
    #expect(
      line.text
        == "Sign in with Apple failed"
        + " error=com.apple.AuthenticationServices.AuthorizationError 1004"
    )
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
