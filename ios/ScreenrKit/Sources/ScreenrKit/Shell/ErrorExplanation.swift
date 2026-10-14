import Foundation

// What to tell the member about a failed request, in the web's words: the
// server's explanation when it sent one, or one for the kind of failure.
extension APIError {
  public var explanation: String {
    if let message, !message.isEmpty { return message }
    switch kind {
    case .offline: return "Could not reach Screenr. Check your connection and try again."
    case .timedOut: return "The request timed out. Please try again."
    case .server, .invalidResponse:
      return "Screenr is temporarily unavailable. Please try again in a moment."
    default: return "Request failed. Please try again."
    }
  }

  // For a screen's read, where a timeout is a refresh's.
  public var readExplanation: String {
    guard kind == .timedOut, message?.isEmpty ?? true else { return explanation }
    return "Refresh timed out. Please try again."
  }
}
