import Foundation

// A finished API call, as the API client reports it to Telemetry. The route is a pattern and the
// request ID is the opaque Screenr-Request-Id the call sent, so it names no member, title, or
// search.
public struct FinishedRequest: Sendable, Equatable {
  public enum Outcome: Sendable, Equatable {
    // The server answered with this HTTP status.
    case response(status: Int)
    // No response arrived, as when the device is offline or the request timed out.
    case failed
    // The caller cancelled the call.
    case cancelled
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
