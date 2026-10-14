import AuthenticationServices
import Foundation
import Testing

@testable import ScreenrKit

// Google's authorization code flow with PKCE, for the iOS client.
@MainActor
struct GoogleSignInTests {
  static let clientID = "1083-abc.apps.googleusercontent.com"
  private let attempt = GoogleSignIn.Attempt(
    verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    state: "state-1",
    nonce: "nonce-1"
  )

  private func google(_ replies: [RecordingTransport.Reply] = []) -> (
    GoogleSignIn, RecordingTransport
  ) {
    let transport = RecordingTransport(replies)
    return (GoogleSignIn(clientID: Self.clientID, transport: transport), transport)
  }

  @Test func computesTheS256Challenge() {
    // RFC 7636, appendix B.
    #expect(attempt.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  }

  @Test func makesNewSecretsForEachAttempt() {
    let first = GoogleSignIn.Attempt()
    let second = GoogleSignIn.Attempt()
    let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    // RFC 7636 allows 43 to 128 unreserved characters.
    #expect(first.verifier.count == 43)
    #expect(first.verifier.allSatisfy(unreserved.contains))
    #expect(first.verifier != second.verifier)
    #expect(first.state != second.state)
    #expect(first.nonce != second.nonce)
    #expect(Set([first.verifier, first.state, first.nonce]).count == 3)
  }

  @Test func redirectsToTheReversedClientID() {
    let (google, _) = google()

    #expect(google.callbackScheme == "com.googleusercontent.apps.1083-abc")
    #expect(google.redirectURI == "com.googleusercontent.apps.1083-abc:/oauthredirect")
  }

  @Test func buildsTheAuthorizationURL() throws {
    let (google, _) = google()

    let url = try google.authorizationURL(for: attempt)

    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.scheme == "https")
    #expect(components.host == "accounts.google.com")
    #expect(components.path == "/o/oauth2/v2/auth")
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] { query[item.name] = item.value }
    #expect(
      query == [
        "client_id": Self.clientID,
        "redirect_uri": "com.googleusercontent.apps.1083-abc:/oauthredirect",
        "response_type": "code",
        "scope": "openid email profile",
        "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        "code_challenge_method": "S256",
        "state": "state-1",
        "nonce": "nonce-1",
      ]
    )
  }

  @Test func readsTheCodeFromTheRedirect() throws {
    let (google, _) = google()
    let redirect = "com.googleusercontent.apps.1083-abc:/oauthredirect"

    let code = try google.code(
      from: try #require(URL(string: "\(redirect)?state=state-1&code=4%2F0Ab&scope=email")),
      for: attempt
    )

    #expect(code == "4/0Ab")
  }

  @Test(
    arguments: [
      (
        "com.googleusercontent.apps.1083-abc:/oauthredirect?state=other&code=abc",
        .unexpectedRedirect
      ),
      ("com.googleusercontent.apps.1083-abc:/oauthredirect?code=abc", .unexpectedRedirect),
      ("com.googleusercontent.apps.1083-abc:/oauthredirect?state=state-1", .unexpectedRedirect),
      ("com.example.other:/oauthredirect?state=state-1&code=abc", .unexpectedRedirect),
      (
        "com.googleusercontent.apps.1083-abc:/oauthredirect?state=state-1&error=access_denied",
        .cancelled
      ),
      (
        "com.googleusercontent.apps.1083-abc:/oauthredirect?state=state-1&error=server_error",
        .unexpectedRedirect
      ),
    ] as [(String, GoogleSignInError)]
  )
  func refusesARedirectForAnotherAttempt(redirect: String, expected: GoogleSignInError) throws {
    let (google, _) = google()
    let url = try #require(URL(string: redirect))

    #expect(throws: expected) { try google.code(from: url, for: attempt) }
  }

  @Test func redeemsTheCodeWithTheVerifierAndNoSecret() async throws {
    let (google, transport) = google([
      try .json(
        200,
        ["access_token": "access", "id_token": "google-id-token", "token_type": "Bearer"]
      )
    ])

    let token = try await google.idToken(forCode: "4/0Ab", attempt: attempt)

    #expect(token == "google-id-token")
    let request = try #require(transport.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://oauth2.googleapis.com/token")
    #expect(
      request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded"
    )
    #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
    let body = String(decoding: try #require(request.httpBody), as: UTF8.self)
    #expect(
      FormEncoding.decode(body) == [
        "grant_type": "authorization_code",
        "code": "4/0Ab",
        "client_id": Self.clientID,
        "redirect_uri": "com.googleusercontent.apps.1083-abc:/oauthredirect",
        "code_verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      ]
    )
    #expect(body.contains("code=4%2F0Ab"))
  }

  @Test func reportsARejectedCode() async throws {
    let (google, _) = google([
      try .json(400, ["error": "invalid_grant", "error_description": "Bad Request"])
    ])

    await #expect(throws: GoogleSignInError.tokenRejected(status: 400, error: "invalid_grant")) {
      try await google.idToken(forCode: "used", attempt: attempt)
    }
  }

  @Test func reportsAnAnswerWithoutAnIDToken() async throws {
    let (google, _) = google([try .json(200, ["access_token": "access"])])

    await #expect(throws: GoogleSignInError.invalidTokenResponse) {
      try await google.idToken(forCode: "4/0Ab", attempt: attempt)
    }
  }

  @Test func reportsAnUnreachableTokenEndpoint() async throws {
    let (google, _) = google([.failure(URLError(.notConnectedToInternet))])

    await #expect(throws: GoogleSignInError.unreachable) {
      try await google.idToken(forCode: "4/0Ab", attempt: attempt)
    }
  }

  @Test func signsInThroughTheWebSession() async throws {
    let (google, transport) = google([try .json(200, ["id_token": "google-id-token"])])
    let authenticator = RedirectingAuthenticator()

    let credential = try await google.signIn(with: authenticator)

    let opened = try #require(authenticator.opened)
    #expect(opened.callbackScheme == "com.googleusercontent.apps.1083-abc")
    var query: [String: String] = [:]
    for item in URLComponents(url: opened.url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
      query[item.name] = item.value
    }
    #expect(credential == GoogleCredential(idToken: "google-id-token", nonce: query["nonce"] ?? ""))
    let body = String(decoding: try #require(transport.requests.first?.httpBody), as: UTF8.self)
    let form = FormEncoding.decode(body)
    #expect(form["code"] == "redirected-code")
    #expect(
      GoogleSignIn.Attempt.challenge(for: form["code_verifier"] ?? "") == query["code_challenge"]
    )
  }

  @Test func treatsAClosedSheetAsCancelled() async throws {
    let (google, transport) = google()

    await #expect(throws: GoogleSignInError.cancelled) {
      try await google.signIn(
        with: FailingAuthenticator(error: ASWebAuthenticationSessionError(.canceledLogin))
      )
    }
    await #expect(throws: GoogleSignInError.sessionFailed) {
      try await google.signIn(
        with: FailingAuthenticator(
          error: ASWebAuthenticationSessionError(.presentationContextInvalid)
        )
      )
    }
    #expect(transport.requests.isEmpty)
  }
}

// Redirects at once with the attempt's state and a fixed code, and records the
// page it was asked to open.
@MainActor
final class RedirectingAuthenticator: WebAuthenticator {
  struct Opened {
    let url: URL
    let callbackScheme: String
  }

  private(set) var opened: Opened?

  nonisolated init() {}

  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    opened = Opened(url: url, callbackScheme: callbackScheme)
    var state = ""
    for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    where item.name == "state" {
      state = item.value ?? ""
    }
    guard
      let redirect = URL(
        string: "\(callbackScheme):/oauthredirect?state=\(state)&code=redirected-code"
      )
    else { throw URLError(.badURL) }
    return redirect
  }
}

struct FailingAuthenticator: WebAuthenticator {
  let error: any Error

  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    throw error
  }
}
