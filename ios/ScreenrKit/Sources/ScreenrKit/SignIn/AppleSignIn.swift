import CryptoKit
import Foundation

// One Sign in with Apple attempt's nonce. The authorization request carries
// its SHA-256 hex digest, which Apple copies into the identity token, and the
// server compares the raw value with that.
public struct AppleNonce: Hashable, Sendable {
  public let raw: String

  public init() {
    raw = RandomText.make()
  }

  init(raw: String) {
    self.raw = raw
  }

  public var hashed: String {
    SHA256.hash(data: Data(raw.utf8))
      .map { byte in
        String(byte, radix: 16).leftPadded(to: 2)
      }
      .joined()
  }
}

// What the server needs from an Apple ID credential.
public struct AppleCredential: Hashable, Sendable {
  public let identityToken: String
  public let authorizationCode: String
  // Apple shares the name only on a person's first authorization.
  public let name: AppleName?

  public init(identityToken: String, authorizationCode: String, name: AppleName?) {
    self.identityToken = identityToken
    self.authorizationCode = authorizationCode
    self.name = name
  }

  // The fields of `ASAuthorizationAppleIDCredential`. Nil when Apple left out
  // the identity token or the authorization code.
  public init?(identityToken: Data?, authorizationCode: Data?, fullName: PersonNameComponents?) {
    guard let identityToken, let authorizationCode,
      let token = String(data: identityToken, encoding: .utf8), !token.isEmpty,
      let code = String(data: authorizationCode, encoding: .utf8), !code.isEmpty
    else { return nil }
    let first = Self.nonEmpty(fullName?.givenName)
    let last = Self.nonEmpty(fullName?.familyName)
    self.init(
      identityToken: token,
      authorizationCode: code,
      name: first == nil && last == nil ? nil : AppleName(first: first, last: last)
    )
  }

  private static func nonEmpty(_ text: String?) -> String? {
    guard let text else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

// Random URL-safe text for nonces, PKCE verifiers, and OAuth states: 32
// random bytes from the system's secure generator, in unpadded base64url.
enum RandomText {
  static func make(bytes count: Int = 32) -> String {
    var generator = SystemRandomNumberGenerator()
    let bytes = (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return base64URL(Data(bytes))
  }

  static func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

extension String {
  fileprivate func leftPadded(to length: Int) -> String {
    String(repeating: "0", count: Swift.max(0, length - count)) + self
  }
}
