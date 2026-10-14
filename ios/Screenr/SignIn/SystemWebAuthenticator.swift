import AuthenticationServices
import ScreenrKit
import SwiftUI

// Google's sign-in page in SwiftUI's web authentication session. It shares
// Safari's cookies, so a person already signed in to Google picks an account
// without typing a password.
nonisolated struct SystemWebAuthenticator: WebAuthenticator {
  let session: WebAuthenticationSession

  @MainActor
  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    try await session.authenticate(
      using: url,
      callback: .customScheme(callbackScheme),
      preferredBrowserSession: .shared,
      additionalHeaderFields: [:]
    )
  }
}
