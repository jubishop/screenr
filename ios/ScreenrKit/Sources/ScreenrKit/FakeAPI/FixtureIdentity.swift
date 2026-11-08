import AuthenticationServices
import Foundation

// Stand-ins for Apple's and Google's authorization, and the invitation
// pickup, in Screenr Dev against the fixture API, which UI tests drive without an Apple ID or a Google account.
// Each stub credential carries what the real one proves, and the fixture API
// checks it as the server and Google would: Apple's identity token names the
// hashed nonce, Google's code names the PKCE challenge and the nonce, and
// Google's ID token names the nonce.
public enum FixtureIdentity {
  static let appleTokenPrefix = "fixture-apple-token."
  static let appleCode = "fixture-apple-code"
  static let googleCodePrefix = "fixture-google-code."
  static let googleTokenPrefix = "fixture-google-token."
  // The name Apple shares on a first authorization.
  public static let appleName = AppleName(first: "Pat", last: "Morgan")

  public static func appleCredential(hashedNonce: String) -> AppleCredential {
    AppleCredential(
      identityToken: appleTokenPrefix + hashedNonce,
      authorizationCode: appleCode,
      name: appleName
    )
  }

  // Whether a `sign-in/social` body carries a stub credential, as the server
  // would verify the real one.
  static func accepts(_ body: JSONValue?) -> Bool {
    guard case .object(let fields)? = body,
      case .string(let provider)? = fields["provider"],
      case .object(let idToken)? = fields["idToken"],
      case .string(let token)? = idToken["token"],
      case .string(let nonce)? = idToken["nonce"]
    else { return false }
    switch provider {
    case "apple":
      guard case .object(let additional)? = fields["additionalData"],
        case .string(let code)? = additional["authorizationCode"]
      else { return false }
      return token == appleTokenPrefix + AppleNonce(raw: nonce).hashed && code == appleCode
    case "google":
      return token == googleTokenPrefix + nonce
    default:
      return false
    }
  }

  // Google's token endpoint: the stub code redeems for a stub ID token when
  // the verifier matches its challenge and the client sent no secret.
  static func redeem(_ form: [String: String]) -> String? {
    guard form["grant_type"] == "authorization_code", form["client_secret"] == nil,
      form["client_id"]?.hasSuffix(GoogleSignIn.clientIDSuffix) == true,
      form["redirect_uri"]?.hasSuffix(":/oauthredirect") == true,
      let verifier = form["code_verifier"], let code = form["code"],
      code.hasPrefix(googleCodePrefix)
    else { return nil }
    let parts = code.dropFirst(googleCodePrefix.count).split(separator: ".")
    guard parts.count == 2, parts[0] == GoogleSignIn.Attempt.challenge(for: verifier) else {
      return nil
    }
    return googleTokenPrefix + parts[1]
  }
}

// Answers Google's authorization page at once, as if the member chose an
// account and consented: it redirects with the request's state and a stub
// code that names its PKCE challenge and nonce.
public struct FixtureWebAuthenticator: WebAuthenticator {
  public init() {}

  public func authenticate(url: URL, callback: WebCallback) async throws -> URL {
    var query: [String: String] = [:]
    for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
      query[item.name] = item.value
    }
    guard case .customScheme(let callbackScheme) = callback,
      query["code_challenge_method"] == "S256",
      let challenge = query["code_challenge"], let nonce = query["nonce"],
      let state = query["state"], let redirect = query["redirect_uri"],
      redirect.hasPrefix(callbackScheme + ":"),
      var callback = URLComponents(string: redirect)
    else { throw URLError(.badURL) }
    callback.queryItems = [
      URLQueryItem(name: "state", value: state),
      URLQueryItem(
        name: "code",
        value: FixtureIdentity.googleCodePrefix + challenge + "." + nonce
      ),
    ]
    guard let url = callback.url else { throw URLError(.badURL) }
    return url
  }
}

// Answers the invitation pickup's page at once with the scenario's outcome:
// Alice's invitation, none, or the person declining iOS's prompt.
public struct FixtureInvitationPickup: WebAuthenticator {
  // Alice's invitation in the fixtures.
  public static let token = "8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"

  let outcome: FixtureScenario.Pickup

  public init(outcome: FixtureScenario.Pickup) {
    self.outcome = outcome
  }

  public func authenticate(url: URL, callback: WebCallback) async throws -> URL {
    guard url.path() == InvitationPickup.path, case .https(let host, let path) = callback else {
      throw URLError(.badURL)
    }
    var components = URLComponents()
    components.scheme = "https"
    components.host = host
    components.path = path
    switch outcome {
    case .found: components.queryItems = [URLQueryItem(name: "token", value: Self.token)]
    case .missing: break
    case .declined: throw ASWebAuthenticationSessionError(.canceledLogin)
    }
    guard let redirect = components.url else { throw URLError(.badURL) }
    return redirect
  }
}
