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

  private struct Envelope: Decodable {
    struct Response: Decodable {
      let body: JSONValue
    }

    let response: Response
  }
}

// Answers requests in order with canned replies, and records each request.
final class RecordingTransport: HTTPTransport {
  enum Reply: Sendable {
    case response(status: Int, headers: [String: String] = [:], body: Data = Data())
    case failure(URLError)

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

  init(_ replies: [Reply]) {
    self.replies = Mutex(replies)
  }

  var requests: [URLRequest] { sent.withLock { $0 } }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    sent.withLock { $0.append(request) }
    let reply = replies.withLock { $0.isEmpty ? nil : $0.removeFirst() }
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
    case nil: throw URLError(.resourceUnavailable)
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
      visits: visits
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
