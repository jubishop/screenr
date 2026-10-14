import Foundation

// Better Auth's sign-in and sign-out routes, under `/api/auth/`. A sign-in
// that succeeds stores the session token from the `set-auth-token` header,
// and signing out removes it. A new member's requests carry the invitation
// token of the link they joined through.

extension APIRequest where Response == Acknowledgement {
  // Emails a one-time sign-in code. The response is the same whether or not
  // the address belongs to a member, so it reveals nothing about accounts.
  public static func sendCode(email: String, invitation: String? = nil) -> Self {
    APIRequest(
      method: .post,
      endpoint: .auth("email-otp/send-verification-otp"),
      body: .json(["email": .string(email), "type": "sign-in"]),
      invitation: invitation
    )
  }

  public static func signIn(email: String, code: String, invitation: String? = nil) -> Self {
    APIRequest(
      method: .post,
      endpoint: .auth("sign-in/email-otp"),
      body: .json(["email": .string(email), "otp": .string(code)]),
      invitation: invitation,
      sessionChange: .signIn
    )
  }

  // Sign in with Apple. `nonce` is the raw value whose SHA-256 hex digest the
  // authorization request carried. Apple gives the person's name only on the
  // first authorization; pass it then.
  public static func signInWithApple(
    identityToken: String,
    authorizationCode: String,
    nonce: String,
    name: AppleName? = nil,
    invitation: String? = nil
  ) -> Self {
    var idToken: [String: JSONValue] = ["token": .string(identityToken), "nonce": .string(nonce)]
    if let name {
      idToken["user"] = [
        "name": .members(["firstName": .optional(name.first), "lastName": .optional(name.last)])
      ]
    }
    return APIRequest(
      method: .post,
      endpoint: .auth("sign-in/social"),
      body: .json([
        "provider": "apple",
        "idToken": .object(idToken),
        "additionalData": ["authorizationCode": .string(authorizationCode)],
      ]),
      invitation: invitation,
      sessionChange: .signIn
    )
  }

  // Google sign-in with the ID token from Google's authorization code flow.
  // `nonce` is the value the authorization request carried.
  public static func signInWithGoogle(
    idToken: String,
    nonce: String,
    invitation: String? = nil
  ) -> Self {
    APIRequest(
      method: .post,
      endpoint: .auth("sign-in/social"),
      body: .json([
        "provider": "google",
        "idToken": ["token": .string(idToken), "nonce": .string(nonce)],
      ]),
      invitation: invitation,
      sessionChange: .signIn
    )
  }

  // Ends this device's session on the server, then removes its token.
  public static var signOut: Self {
    APIRequest(
      method: .post,
      endpoint: .auth("sign-out"),
      body: .json([:]),
      sessionChange: .signOut
    )
  }
}

// The name Apple shares on a person's first Sign in with Apple.
public struct AppleName: Hashable, Sendable {
  public let first: String?
  public let last: String?

  public init(first: String?, last: String?) {
    self.first = first
    self.last = last
  }
}
