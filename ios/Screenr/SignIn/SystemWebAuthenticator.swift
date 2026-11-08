import AuthenticationServices
import ScreenrKit
import SwiftUI

// SwiftUI's web authentication session, for Google's sign-in page and the
// invitation pickup. It shares Safari's cookies, so a person already signed in
// to Google picks an account without typing a password, and the pickup finds
// the invitation an invitation link saved in Safari.
nonisolated struct SystemWebAuthenticator: WebAuthenticator {
  let session: WebAuthenticationSession

  @MainActor
  func authenticate(url: URL, callback: WebCallback) async throws -> URL {
    let ending: ASWebAuthenticationSession.Callback =
      switch callback {
      case .customScheme(let scheme): .customScheme(scheme)
      case .https(let host, let path): .https(host: host, path: path)
      }
    return try await session.authenticate(
      using: url,
      callback: ending,
      preferredBrowserSession: .shared,
      additionalHeaderFields: [:]
    )
  }
}
