import Foundation

// A failed API request. `requestID` is the `Screenr-Request-Id` the request
// sent, which the server's logs and Sentry reports also carry, and `message`
// is the server's explanation when it sent one.
public struct APIError: Error, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    // 401: no session, or it ended. The client has cleared its token.
    case signedOut
    // 403, such as a signed-in person who has not finished setup.
    case forbidden
    // 404: a missing title, person, entry, or page.
    case notFound
    // 408, or no response before the request's deadline.
    case timedOut
    // 429.
    case rateLimited
    // 426: this build is older than the server accepts.
    case updateRequired(minimumBuild: Int?)
    // 5xx.
    case server(status: Int)
    // Any other 4xx, such as invalid input (400) or a body too large (413).
    case rejected(status: Int)
    // No response: the device is offline or the server is unreachable.
    case offline
    case cancelled
    // A response the client cannot read, such as a proxy's error page.
    case invalidResponse
    // A request the client could not build, such as a body it cannot encode.
    case invalidRequest
    // The session token could not be saved to or removed from the Keychain.
    case keychain
    // A sign-in meant to confirm the signed-in member reached a different
    // account. The client kept the member's session and ended the other one.
    case otherAccount
  }

  public let kind: Kind
  public let message: String?
  // Better Auth's code for the error, such as `INVALID_OTP`, when it sent one.
  public let code: String?
  public let requestID: String

  public init(kind: Kind, message: String? = nil, code: String? = nil, requestID: String) {
    self.kind = kind
    self.message = message
    self.code = code
    self.requestID = requestID
  }

  // Repeating the request cannot help, so background reads stop until the
  // member acts. Timeouts, rate limits, server errors, and network failures
  // can pass, so polling continues through them.
  public var isPermanent: Bool {
    switch kind {
    case .signedOut, .forbidden, .notFound, .updateRequired, .rejected, .invalidRequest, .keychain,
      .otherAccount:
      true
    case .timedOut, .rateLimited, .server, .offline, .cancelled, .invalidResponse: false
    }
  }

  init(status: Int, body: ErrorBody?, requestID: String) {
    let kind: Kind =
      switch status {
      case 401: .signedOut
      case 403: .forbidden
      case 404: .notFound
      case 408: .timedOut
      case 426: .updateRequired(minimumBuild: body?.minimumBuild)
      case 429: .rateLimited
      case 400..<500: .rejected(status: status)
      case 500..<600: .server(status: status)
      default: .invalidResponse
      }
    self.init(
      kind: kind,
      message: body?.error ?? body?.message,
      code: body?.code,
      requestID: requestID
    )
  }

  // What to tell the member: the server's message when it sent one, or else a
  // sentence for the kind of failure, or `fallback`.
  public func explanation(otherwise fallback: String) -> String {
    if let message, !message.isEmpty { return message }
    return Self.explanation(of: kind) ?? fallback
  }

  // A sentence for failures that need no server message to explain.
  public static func explanation(of kind: Kind) -> String? {
    switch kind {
    case .offline: "You’re offline. Check your connection and try again."
    case .timedOut: "Screenr took too long to answer. Try again."
    case .server: "Screenr is having trouble right now. Try again soon."
    case .rateLimited: "Too many tries. Wait a moment, then try again."
    case .otherAccount:
      "That sign-in is for a different Screenr account. Use one of this account’s sign-in methods."
    default: nil
    }
  }
}
