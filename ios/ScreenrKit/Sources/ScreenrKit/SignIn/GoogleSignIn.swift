import AuthenticationServices
import CryptoKit
import Foundation

// Opens a sign-in page in a browser session and returns the URL that the page
// finally redirects to. The app uses SwiftUI's web authentication session;
// Screenr Dev's fixture API answers at once.
public protocol WebAuthenticator: Sendable {
  @MainActor func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

// Google sign-in for the iOS OAuth client, without Google's SDK. It runs the
// authorization code flow with PKCE in a web authentication session, then
// redeems the code at Google's token endpoint for an ID token. An iOS client
// has no secret: only the app that holds the verifier can redeem the code.
public struct GoogleSignIn: Sendable {
  static let clientIDSuffix = ".apps.googleusercontent.com"
  static let tokenHost = "oauth2.googleapis.com"
  static let scopes = "openid email profile"

  public let clientID: String
  private let transport: any HTTPTransport

  // `transport` reaches Google's token endpoint.
  public init(clientID: String, transport: any HTTPTransport) {
    self.clientID = clientID
    self.transport = transport
  }

  // The reversed client ID, the only redirect scheme Google allows an iOS
  // client.
  public var callbackScheme: String {
    let client =
      clientID.hasSuffix(Self.clientIDSuffix)
      ? String(clientID.dropLast(Self.clientIDSuffix.count)) : clientID
    return "com.googleusercontent.apps.\(client)"
  }

  public var redirectURI: String { "\(callbackScheme):/oauthredirect" }

  // One attempt's secrets: the PKCE verifier, the state that ties Google's
  // redirect to this attempt, and the nonce that Google copies into the ID
  // token and the server checks.
  public struct Attempt: Hashable, Sendable {
    public let verifier: String
    public let state: String
    public let nonce: String

    public init() {
      self.init(verifier: RandomText.make(), state: RandomText.make(), nonce: RandomText.make())
    }

    init(verifier: String, state: String, nonce: String) {
      self.verifier = verifier
      self.state = state
      self.nonce = nonce
    }

    // The S256 challenge: the unpadded base64url SHA-256 of the verifier.
    public var challenge: String { Self.challenge(for: verifier) }

    static func challenge(for verifier: String) -> String {
      RandomText.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
  }

  // Signs in with Google and returns the ID token for the server, with the
  // nonce that it carries.
  public func signIn(with authenticator: any WebAuthenticator) async throws(GoogleSignInError)
    -> GoogleCredential
  {
    let attempt = Attempt()
    let url = try authorizationURL(for: attempt)
    let callback: URL
    do {
      callback = try await authenticator.authenticate(url: url, callbackScheme: callbackScheme)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      throw .cancelled
    } catch is CancellationError {
      throw .cancelled
    } catch {
      throw .sessionFailed
    }
    let code = try code(from: callback, for: attempt)
    let idToken = try await idToken(forCode: code, attempt: attempt)
    return GoogleCredential(idToken: idToken, nonce: attempt.nonce)
  }

  public func authorizationURL(for attempt: Attempt) throws(GoogleSignInError) -> URL {
    var components = URLComponents()
    components.scheme = "https"
    components.host = "accounts.google.com"
    components.path = "/o/oauth2/v2/auth"
    components.queryItems = [
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "redirect_uri", value: redirectURI),
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "scope", value: Self.scopes),
      URLQueryItem(name: "code_challenge", value: attempt.challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: attempt.state),
      URLQueryItem(name: "nonce", value: attempt.nonce),
    ]
    guard let url = components.url else { throw .invalidRequest }
    return url
  }

  // The authorization code in Google's redirect, once the redirect is shown
  // to answer this attempt. A person who declines consent gets
  // `error=access_denied`, which counts as cancelling.
  public func code(from callback: URL, for attempt: Attempt) throws(GoogleSignInError) -> String {
    guard callback.scheme == callbackScheme,
      let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
    else { throw .unexpectedRedirect }
    var values: [String: String] = [:]
    for item in items { values[item.name] = item.value ?? "" }
    guard values["state"] == attempt.state else { throw .unexpectedRedirect }
    if let error = values["error"] {
      throw error == "access_denied" ? .cancelled : .unexpectedRedirect
    }
    guard let code = values["code"], !code.isEmpty else { throw .unexpectedRedirect }
    return code
  }

  // Redeems the code with the attempt's verifier. The iOS client sends no
  // secret.
  public func idToken(forCode code: String, attempt: Attempt) async throws(GoogleSignInError)
    -> String
  {
    var components = URLComponents()
    components.scheme = "https"
    components.host = Self.tokenHost
    components.path = "/token"
    guard let url = components.url else { throw .invalidRequest }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = Data(
      FormEncoding.encode([
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", clientID),
        ("redirect_uri", redirectURI),
        ("code_verifier", attempt.verifier),
      ])
      .utf8
    )
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.send(request)
    } catch is CancellationError {
      throw .cancelled
    } catch {
      throw .unreachable
    }
    guard (200..<300).contains(response.statusCode) else {
      throw .tokenRejected(
        status: response.statusCode,
        error: Self.decode(TokenError.self, data)?.error
      )
    }
    guard let token = Self.decode(TokenResponse.self, data)?.idToken, !token.isEmpty else {
      throw .invalidTokenResponse
    }
    return token
  }

  private struct TokenResponse: Decodable {
    let idToken: String

    enum CodingKeys: String, CodingKey {
      case idToken = "id_token"
    }
  }

  // Google's OAuth error, such as `invalid_grant`.
  private struct TokenError: Decodable {
    let error: String
  }

  private static func decode<Value: Decodable>(_ type: Value.Type, _ data: Data) -> Value? {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      return nil
    }
  }
}

// Google's ID token for the server, and the nonce the authorization request
// carried, which the server checks against the token.
public struct GoogleCredential: Hashable, Sendable {
  public let idToken: String
  public let nonce: String

  public init(idToken: String, nonce: String) {
    self.idToken = idToken
    self.nonce = nonce
  }
}

public enum GoogleSignInError: Error, Hashable, Sendable {
  // The person closed the sheet or declined consent.
  case cancelled
  // The web authentication session could not run.
  case sessionFailed
  // The redirect did not answer this attempt, or carried an error.
  case unexpectedRedirect
  // Google refused the code, with its OAuth error, such as `invalid_grant`.
  case tokenRejected(status: Int, error: String?)
  // Google's token endpoint answered without an ID token.
  case invalidTokenResponse
  // Google's token endpoint did not answer.
  case unreachable
  case invalidRequest
}

// `application/x-www-form-urlencoded`, with every character but the unreserved
// ones percent-encoded.
enum FormEncoding {
  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  )

  static func encode(_ fields: [(String, String)]) -> String {
    fields.map { name, value in "\(escape(name))=\(escape(value))" }.joined(separator: "&")
  }

  static func decode(_ text: String) -> [String: String] {
    var fields: [String: String] = [:]
    for pair in text.split(separator: "&") {
      let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      guard let name = parts.first else { continue }
      let value = parts.count > 1 ? parts[1] : ""
      fields[unescape(name)] = unescape(value)
    }
    return fields
  }

  // Percent-encoding fails only for invalid UTF-16, which a String cannot hold.
  private static func escape(_ text: String) -> String {
    text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
  }

  private static func unescape(_ text: Substring) -> String {
    let spaced = text.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }
}
