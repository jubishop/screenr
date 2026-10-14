import Foundation
import Synchronization

@testable import ScreenrKit

// An API for Find a title that answers each search by its text and each other
// action by its name, and records what it was sent.
final class FindAPI: ScreenrAPI {
  enum Reply: Sendable {
    // A response body, such as a fixture's.
    case body(Data)
    case failure(APIError.Kind)
    // Waits until the request is cancelled.
    case hang
    // Answers once the gate opens, even after the request is cancelled.
    case late(Data, Gate)
  }

  struct Sent: Hashable, Sendable {
    let action: String
    let query: [String: String]
    let body: RequestBody?
  }

  private struct State {
    var sent: [Sent] = []
    var nextID = 0
    var watchers: [(id: Int, count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private let replies: [String: Reply]
  private let state = Mutex(State())

  // Replies keyed by search text, or by action name for other actions.
  init(_ replies: [String: Reply]) {
    self.replies = replies
  }

  var sent: [Sent] { state.withLock { $0.sent } }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let action = request.endpoint.path.replacing("/api/screenr/", with: "")
    let (requestID, woken) = state.withLock { state in
      state.sent.append(Sent(action: action, query: request.query, body: request.body))
      let count = state.sent.count
      let woken = state.watchers.filter { $0.count <= count }.map(\.continuation)
      state.watchers.removeAll { $0.count <= count }
      return ("request-\(count)", woken)
    }
    for watcher in woken { watcher.resume() }
    let key = action == "search" ? request.query["q"] ?? "" : action
    switch replies[key] {
    case .body(let data):
      return try decode(data, requestID: requestID)
    case .failure(let kind):
      throw APIError(kind: kind, requestID: requestID)
    case .late(let data, let gate):
      await gate.wait()
      return try decode(data, requestID: requestID)
    case .hang, nil:
      let stream = AsyncStream<Never> { _ in }
      for await _ in stream {}
      throw APIError(kind: .cancelled, requestID: requestID)
    }
  }

  private func decode<Response: Decodable>(
    _ data: Data,
    requestID: String
  ) throws(APIError) -> Response {
    do {
      return try ScreenrJSON.decoder().decode(Response.self, from: data)
    } catch {
      throw APIError(kind: .invalidResponse, requestID: requestID)
    }
  }

  // Waits until the API has received `count` requests.
  func waitForRequests(_ count: Int) async {
    let id = state.withLock { state in
      state.nextID += 1
      return state.nextID
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let waiting = state.withLock { state in
          guard !Task.isCancelled, state.sent.count < count else { return false }
          state.watchers.append((id, count, continuation))
          return true
        }
        if !waiting { continuation.resume() }
      }
    } onCancel: {
      let watcher = state.withLock { state in
        let watcher = state.watchers.first { $0.id == id }
        state.watchers.removeAll { $0.id == id }
        return watcher
      }
      watcher?.continuation.resume()
    }
  }
}

// Holds a reply back until a test opens it.
final class Gate: Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>(
    (false, [])
  )

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let waiting = state.withLock { state in
        guard !state.open else { return false }
        state.waiters.append(continuation)
        return true
      }
      if !waiting { continuation.resume() }
    }
  }

  func open() {
    let waiters = state.withLock { state in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}

// Find a title's data, from fixtures or written out for states the fixtures
// do not show.
enum FindData {
  static func page(_ fixture: String) throws -> SearchScreen {
    try ScreenrJSON.decoder().decode(SearchScreen.self, from: try TestFixtures.body(fixture))
  }

  static func results() throws -> [ViewingTitle] {
    try ScreenrJSON.decoder()
      .decode(
        [ViewingTitle].self,
        from: try TestFixtures.body("actions/search/results")
      )
  }

  static func decode<Value: Decodable>(_ json: JSONValue) throws -> Value {
    try ScreenrJSON.decoder().decode(Value.self, from: try JSONEncoder().encode(json))
  }

  // Viewing options with these sections, keyed `subs` or `free`, of service
  // IDs named after themselves.
  static func viewing(_ status: String = "ok", _ sections: [String: [String]] = [:]) -> JSONValue {
    .object([
      "status": .string(status),
      "checked_at": "2026-10-13T12:00:00.000Z",
      "sections": .array(
        sections.keys.sorted()
          .map { key in
            .object([
              "key": .string(key),
              "label": .string(key),
              "services": .array(
                (sections[key] ?? [])
                  .map { id in
                    [
                      "id": .string(id), "name": .string(id), "logo_path": .null,
                      "route_note": .null,
                    ]
                  }
              ),
            ])
          }
      ),
    ])
  }

  static func title(_ id: String, _ name: String, fields: [String: JSONValue]) -> JSONValue {
    let kind = id.hasPrefix("tv:") ? "tv" : "movie"
    var object: [String: JSONValue] = [
      "id": .string(id), "kind": .string(kind), "name": .string(name),
      "tmdb_id": .integer(Int(id.drop { $0 != ":" }.dropFirst()) ?? 0), "overview": "",
      "poster_path": .null, "release_date": "2024-01-02", "viewing": viewing(),
    ]
    object.merge(fields) { _, field in field }
    return .object(object)
  }

  static func recommendation(
    _ id: String,
    _ name: String,
    status: String? = nil,
    recommended: Bool = false,
    viewing: JSONValue = viewing(),
    by friends: [(String, Int?)] = [("Ben Ortiz", nil)]
  ) -> JSONValue {
    title(
      id,
      name,
      fields: [
        "viewer_status": .nullable(status),
        "viewer_recommended": .bool(recommended),
        "viewing": viewing,
        "recommended_by": .array(
          friends.map { friend in
            [
              "username": .string(friend.0.lowercased()), "display_name": .string(friend.0),
              "rank": rank(friend.1),
            ]
          }
        ),
      ]
    )
  }

  private static func rank(_ rank: Int?) -> JSONValue {
    guard let rank else { return .null }
    return .integer(rank)
  }

  static func page(
    suggestions: [JSONValue] = [],
    recommendations: [JSONValue] = [],
    serviceIds: [String] = []
  ) throws -> SearchScreen {
    try decode([
      "suggestions": .array(suggestions),
      "recommendations": .array(recommendations),
      "serviceIds": .array(serviceIds.map { .string($0) }),
    ])
  }
}
