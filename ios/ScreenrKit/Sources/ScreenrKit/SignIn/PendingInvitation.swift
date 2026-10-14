import Foundation
import Observation

// The invitation token from the `/join/<token>` link a new member opened.
// Requesting a code, signing in, and setup send it as `Screenr-Invitation`,
// which a new person needs to join.
@MainActor
@Observable
public final class PendingInvitation {
  public var token: String?

  public init(token: String? = nil) {
    self.token = token
  }
}

// How the app authorizes with Apple and Google before it posts their tokens
// to the server.
public struct IdentityProviders: Sendable {
  public enum Authorization: Hashable, Sendable {
    // The system's Sign in with Apple sheet, and Google in a web
    // authentication session.
    case system
    // Screenr Dev against the fixture API: stub credentials stand in for
    // Apple's sheet and Google's page, and the fixture API accepts only them.
    case fixture
  }

  public let authorization: Authorization
  public let google: GoogleSignIn

  public init(authorization: Authorization, google: GoogleSignIn) {
    self.authorization = authorization
    self.google = google
  }
}
