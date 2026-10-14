import Foundation

// Receives each API call once it finishes. The API client calls it, and Telemetry implements it:
// it logs the call, adds a breadcrumb, and, in traced sessions, records a span.
public protocol APIRequestObserver: Sendable {
  func requestFinished(_ request: APIRequestRecord)
}

// A finished API call. The route is a pattern and the request ID is the opaque
// Screenr-Request-Id the call sent, so a record names no member, title, or search.
public struct APIRequestRecord: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    // The server answered with this HTTP status.
    case response(status: Int)
    // No response arrived. The code is the URLError's, such as -1009 when offline.
    case failed(code: Int)
  }

  public let method: String
  public let route: RoutePattern
  public let requestID: String
  public let outcome: Outcome
  public let duration: Duration

  public init(
    method: String,
    route: RoutePattern,
    requestID: String,
    outcome: Outcome,
    duration: Duration
  ) {
    self.method = method
    self.route = route
    self.requestID = requestID
    self.outcome = outcome
    self.duration = duration
  }
}
