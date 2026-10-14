import Foundation

// One finished API request, for logging and error reports. It names the route
// pattern, never member content such as search text or usernames.
public struct APIRequestRecord: Hashable, Sendable {
  public let method: String
  // Such as `/api/screenr/screen?path=/titles/:kind/:id`.
  public let route: String
  public let requestID: String
  // The HTTP status, or nil when no response arrived.
  public let status: Int?
  public let duration: Duration
  public let error: APIError?
}

// Receives every request the client finishes, successful or not.
public protocol APIRequestObserver: Sendable {
  func requestFinished(_ record: APIRequestRecord)
}
