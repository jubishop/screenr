import Foundation
import ScreenrKit
import Synchronization
import Testing

// The checked-in server fixtures, found from this file's path. This works
// under swift test and in the Simulator, which reads the Mac's file system.
enum TestFixtures {
  static let directory = URL(filePath: #filePath)
    .deletingLastPathComponent()  // Support
    .deletingLastPathComponent()  // ScreenrKitTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // ScreenrKit
    .appending(path: "Fixtures", directoryHint: .isDirectory)

  // A fixture's response body, as the server sent it.
  static func body(_ name: String) throws -> Data {
    let data = try Data(contentsOf: directory.appending(path: "\(name).json"))
    let fixture = try JSONDecoder().decode(Envelope.self, from: data)
    return try JSONEncoder().encode(fixture.response.body)
  }

  // A fixture's response, with its status and headers, as the transport
  // fakes reply.
  static func reply(_ name: String) throws -> RecordingTransport.Reply {
    let data = try Data(contentsOf: directory.appending(path: "\(name).json"))
    let response = try JSONDecoder().decode(Envelope.self, from: data).response
    var headers = response.headers ?? [:]
    headers["Content-Type"] = "application/json"
    return .response(
      status: response.status,
      headers: headers,
      body: try JSONEncoder().encode(response.body)
    )
  }

  private struct Envelope: Decodable {
    struct Response: Decodable {
      let status: Int
      let headers: [String: String]?
      let body: JSONValue
    }

    let response: Response
  }
}

// Holds a reply until the test releases it, as a slow server would. The reply
// comes even if its request was cancelled meanwhile, like one already on its
// way. Cancelling a test that waits for the request, as its time limit does,
// ends the wait.
final class Hold: Sendable {
  private struct State {
    var arrived = false
    var released = false
    var arrivals: [CheckedContinuation<Void, Never>] = []
    var releases: [CheckedContinuation<Void, Never>] = []
  }

  private let state = Mutex(State())

  // The request arrived: returns once the test releases its reply.
  func hold() async {
    let arrivals = state.withLock { state in
      state.arrived = true
      defer { state.arrivals = [] }
      return state.arrivals
    }
    for arrival in arrivals { arrival.resume() }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let released = state.withLock { state in
        if !state.released { state.releases.append(continuation) }
        return state.released
      }
      if released { continuation.resume() }
    }
  }

  // Waits until the request arrives.
  func arrival() async {
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, !state.arrived else { return false }
          state.arrivals.append(continuation)
          return true
        }
        if !waiting { continuation.resume() }
      }
    } onCancel: {
      let arrivals = state.withLock { state in
        defer { state.arrivals = [] }
        return state.arrivals
      }
      for arrival in arrivals { arrival.resume() }
    }
  }

  func release() {
    let releases = state.withLock { state in
      state.released = true
      defer { state.releases = [] }
      return state.releases
    }
    for release in releases { release.resume() }
  }
}

// Answers requests in order with canned replies, and records each request.
final class RecordingTransport: HTTPTransport {
  enum Reply: Sendable {
    case response(status: Int, headers: [String: String] = [:], body: Data = Data())
    case failure(URLError)
    // The reply, once the test releases `hold`.
    indirect case held(Hold, Reply)

    static func json(
      _ status: Int,
      _ body: JSONValue,
      headers: [String: String] = [:]
    ) throws -> Reply {
      .response(status: status, headers: headers, body: try JSONEncoder().encode(body))
    }
  }

  private let replies: Mutex<[Reply]>
  private let sent = Mutex<[URLRequest]>([])
  private let closes = Mutex(0)

  init(_ replies: [Reply]) {
    self.replies = Mutex(replies)
  }

  var requests: [URLRequest] { sent.withLock { $0 } }
  // How many times the client closed the transport.
  var closed: Int { closes.withLock { $0 } }

  func close() {
    closes.withLock { $0 += 1 }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    sent.withLock { $0.append(request) }
    var reply = replies.withLock { $0.isEmpty ? nil : $0.removeFirst() }
    while case .held(let hold, let held) = reply {
      await hold.hold()
      reply = held
    }
    switch reply {
    case .response(let status, let headers, let body):
      guard
        let url = request.url,
        let response = HTTPURLResponse(
          url: url,
          statusCode: status,
          httpVersion: "HTTP/1.1",
          headerFields: headers
        )
      else { throw URLError(.cannotParseResponse) }
      return (body, response)
    case .failure(let error): throw error
    case .held, nil: throw URLError(.resourceUnavailable)
    }
  }
}

final class RecordingObserver: APIRequestObserver {
  private let finished = Mutex<[APIRequestRecord]>([])

  var records: [APIRequestRecord] { finished.withLock { $0 } }

  func requestFinished(_ record: APIRequestRecord) {
    finished.withLock { $0.append(record) }
  }
}

// A client against canned replies, with an in-memory Keychain.
@MainActor
struct TestClient {
  let keychain: InMemoryKeychain
  let session: SessionStore
  let transport: RecordingTransport
  let observer = RecordingObserver()
  // Where the test posts memory warnings for the client.
  let notifications = NotificationCenter()
  let client: ScreenrClient

  init(
    token: String? = nil,
    visits: VisitTracker? = nil,
    replies: [RecordingTransport.Reply]
  ) throws {
    keychain = InMemoryKeychain(token: token)
    session = try SessionStore(keychain: keychain)
    transport = RecordingTransport(replies)
    client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: session,
      transport: transport,
      observer: observer,
      visits: visits,
      notifications: notifications
    )
  }

  func header(_ name: String, request index: Int = 0) -> String? {
    guard transport.requests.indices.contains(index) else { return nil }
    return transport.requests[index].value(forHTTPHeaderField: name)
  }
}

extension URLRequest {
  // The JSON body this request sends.
  var json: JSONValue? {
    get throws {
      guard let httpBody else { return nil }
      return try JSONDecoder().decode(JSONValue.self, from: httpBody)
    }
  }
}
