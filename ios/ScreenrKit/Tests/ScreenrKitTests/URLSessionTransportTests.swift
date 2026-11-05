import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The network transport asks iOS to keep the app running while a write is in
// flight, so leaving the app does not cut it off after the server applied it.
// Reads repeat when the app returns, so they ask for nothing.
@Suite(.timeLimit(.minutes(1)))
struct URLSessionTransportTests {
  private let host = "\(UUID().uuidString.lowercased()).invalid"

  private func request(_ method: String) throws -> URLRequest {
    var request = URLRequest(url: try #require(URL(string: "https://\(host)/api/screenr/comment")))
    request.httpMethod = method
    return request
  }

  @Test func keepsTheProcessRunningUntilAWriteAnswers() async throws {
    let activity = RecordingActivity()
    let transport = URLSessionTransport(
      configuration: AnsweringURLProtocol.configuration(host: host, events: activity),
      activity: activity
    )
    defer { AnsweringURLProtocol.forget(host) }

    let (_, response) = try await transport.send(try request("POST"))

    #expect(response.statusCode == 200)
    #expect(activity.events == [.began, .sent, .ended])
  }

  @Test func keepsTheProcessRunningUntilAFailedWriteEnds() async throws {
    let activity = RecordingActivity()
    let transport = URLSessionTransport(
      configuration: AnsweringURLProtocol.configuration(
        host: host,
        events: activity,
        failing: true
      ),
      activity: activity
    )
    defer { AnsweringURLProtocol.forget(host) }

    await #expect(throws: URLError.self) { try await transport.send(try request("POST")) }

    #expect(activity.events == [.began, .sent, .ended])
  }

  @Test func asksNothingForARead() async throws {
    let activity = RecordingActivity()
    let transport = URLSessionTransport(
      configuration: AnsweringURLProtocol.configuration(host: host, events: activity),
      activity: activity
    )
    defer { AnsweringURLProtocol.forget(host) }

    _ = try await transport.send(try request("GET"))

    #expect(activity.events == [.sent])
  }
}

// iOS's background time, as a record of when the transport began and ended
// it, beside the requests that reached the network meanwhile.
final class RecordingActivity: BackgroundActivity {
  enum Event: Hashable, Sendable {
    case began
    case sent
    case ended
  }

  private let recorded = Mutex<[Event]>([])

  var events: [Event] { recorded.withLock { $0 } }

  func record(_ event: Event) {
    recorded.withLock { $0.append(event) }
  }

  func keepRunning<Value>(
    _ reason: String,
    during work: () async throws -> Value
  ) async rethrows -> Value {
    record(.began)
    defer { record(.ended) }
    return try await work()
  }
}

// Answers every request to its host in process, noting each one as it
// reaches the network.
private final class AnsweringURLProtocol: URLProtocol {
  private struct Listener {
    let events: RecordingActivity
    let failing: Bool
  }

  private static let listeners = Mutex<[String: Listener]>([:])

  static func configuration(
    host: String,
    events: RecordingActivity,
    failing: Bool = false
  ) -> URLSessionConfiguration {
    listeners.withLock { $0[host] = Listener(events: events, failing: failing) }
    let configuration = URLSessionTransport.configuration()
    configuration.protocolClasses = [AnsweringURLProtocol.self]
    return configuration
  }

  static func forget(_ host: String) {
    _ = listeners.withLock { $0.removeValue(forKey: host) }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let host = url.host(),
      let listener = Self.listeners.withLock({ $0[host] }),
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    listener.events.record(.sent)
    if listener.failing {
      client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("{}".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
