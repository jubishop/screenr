import Foundation
import Testing

@testable import ScreenrKit

// Linking Google and Sign in with Apple from Settings: end to end against the
// fixture API's stand-ins for Google and Apple, and Better Auth's errors from
// canned replies.
@MainActor
struct AccountLinkModelTests {
  private func fixtureServices() throws -> AppServices {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": GoogleSignInTests.clientID,
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
    return try AppServices(
      configuration: configuration,
      arguments: ["Screenr", "-ScreenrFixtures", TestFixtures.directory.path()]
    )
  }

  // Google's stand-in redeems its code at the fixture API's token endpoint,
  // and `test` answers the link.
  private func model(_ test: TestClient, onLink: @escaping @MainActor () -> Void = {}) throws
    -> AccountLinkModel
  {
    AccountLinkModel(
      api: test.client,
      providers: IdentityProviders(
        authorization: .fixture,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: try FixtureTransport(directory: TestFixtures.directory)
        )
      ),
      onLink: onLink
    )
  }

  @Test func linksGoogleAndAppleThroughTheFixtureAPI() async throws {
    let services = try fixtureServices()
    var reads = 0
    let model = AccountLinkModel(api: services.api, providers: services.identity) { reads += 1 }

    await model.linkGoogle(using: FixtureWebAuthenticator())
    #expect(model.failure == nil)
    #expect(model.linked == .google)
    await model.linkFixtureApple()

    #expect(model.failure == nil)
    #expect(model.linked == .apple)
    #expect(model.state == .idle)
    #expect(reads == 2)
    #expect(services.session.phase == .signedIn)
  }

  @Test(arguments: [
    (
      "LINKING_DIFFERENT_EMAILS_NOT_ALLOWED",
      "Choose the Google account with the same email address as your Screenr account."
    ),
    ("INVALID_TOKEN", "Screenr could not confirm your Google account. Try again."),
    ("LINKING_NOT_ALLOWED", "Verify your Google account's email address, then try again."),
  ])
  func explainsWhyGoogleWasNotLinked(code: String, message: String) async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(401, ["code": .string(code), "message": "Not linked"])]
    )
    var reads = 0
    let model = try model(test) { reads += 1 }

    await model.linkGoogle(using: FixtureWebAuthenticator())

    #expect(model.failure == message)
    #expect(model.linked == nil)
    #expect(reads == 0)
    #expect(test.session.phase == .signedIn)
  }

  @Test func asksForTheMatchingAppleIDAndItsSharedAddress() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [
        try .json(401, ["code": "LINKING_DIFFERENT_EMAILS_NOT_ALLOWED", "message": "Not linked"]),
        try .json(409, ["code": "SOCIAL_ACCOUNT_ALREADY_LINKED", "message": "Already linked"]),
        try .json(401, ["message": "Apple did not confirm this sign-in. Try again."]),
      ]
    )
    let model = try model(test)

    await model.linkFixtureApple()
    #expect(
      model.failure
        == "Use the Apple ID with the same email address as your Screenr account, and share your email instead of hiding it."
    )
    await model.linkFixtureApple()
    #expect(model.failure == "That Apple account already signs in to another Screenr account.")
    await model.linkFixtureApple()
    #expect(model.failure == "Apple did not confirm this sign-in. Try again.")
    #expect(test.session.phase == .signedIn)
  }

  @Test func sendsTheRawNonceOfTheAppleRequest() async throws {
    let test = try TestClient(
      token: "signed-token",
      replies: [try .json(200, ["url": "", "status": true, "redirect": false])]
    )
    let model = try model(test)

    let hashed = model.startApple()
    await model.linkApple(
      AppleCredential(identityToken: "token", authorizationCode: "code", name: nil)
    )

    let body = try #require(try test.transport.requests.first?.json)
    guard case .object(let fields) = body, case .object(let idToken)? = fields["idToken"],
      case .string(let raw)? = idToken["nonce"]
    else {
      Issue.record("The link has no nonce")
      return
    }
    #expect(AppleNonce(raw: raw).hashed == hashed)
    #expect(model.linked == .apple)
  }

  @Test func linksAppleOnlyForTheRequestItStarted() async throws {
    let test = try TestClient(token: "signed-token", replies: [])
    let model = try model(test)

    await model.linkApple(
      AppleCredential(identityToken: "token", authorizationCode: "code", name: nil)
    )

    #expect(model.failure == "Sign in with Apple did not finish. Try again.")
    #expect(test.transport.requests.isEmpty)
  }
}
