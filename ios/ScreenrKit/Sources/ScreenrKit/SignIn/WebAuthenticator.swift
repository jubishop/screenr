import Foundation

// Opens a page in a browser session and returns the URL that the page finally
// redirects to, such as Google's sign-in page or the invitation pickup. The
// app uses SwiftUI's web authentication session, which shares Safari's
// cookies; Screenr Dev's fixture API answers at once.
public protocol WebAuthenticator: Sendable {
  @MainActor func authenticate(url: URL, callback: WebCallback) async throws -> URL
}

// Where a web authentication session ends: a redirect to a URL scheme the app
// registers, as Google's is, or to an https page on a domain whose web
// credentials name the app, which iOS hands to no other app.
public enum WebCallback: Hashable, Sendable {
  case customScheme(String)
  case https(host: String, path: String)
}
