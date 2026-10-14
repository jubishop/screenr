import Foundation
import ScreenrKit
import Synchronization
import Testing

// Feed entries from the checked-in fixtures, as is or with some fields
// changed, such as a withdrawn Recommend or a new reply from a friend.
enum FeedFixtures {
  // The default feed's entries, as Alice reads them.
  static func entries(_ fixture: String = "screen/feed/default") throws -> [FeedItem] {
    guard case .feed(let page) = try screen(fixture).content else {
      throw FeedFixtureError(description: "\(fixture) is not a feed")
    }
    return page.conversations
  }

  // The raw JSON of one entry, to change before decoding.
  static func json(_ id: String, in fixture: String = "screen/feed/default") throws -> JSONValue {
    let body = try JSONDecoder().decode(JSONValue.self, from: try TestFixtures.body(fixture))
    guard case .object(let screen) = body, case .array(let items)? = screen["conversations"],
      let item = items.first(where: { $0.member("id") == .string(id) })
    else { throw FeedFixtureError(description: "\(fixture) has no entry \(id)") }
    return item
  }

  // An entry with some of its fields replaced.
  static func entry(
    _ id: String,
    changing changes: [String: JSONValue] = [:],
    in fixture: String = "screen/feed/default"
  ) throws -> FeedItem {
    try decode(try json(id, in: fixture).merging(changes))
  }

  static func decode(_ value: JSONValue) throws -> FeedItem {
    try ScreenrJSON.decoder().decode(FeedItem.self, from: try JSONEncoder().encode(value))
  }

  // A comment in the server's form.
  static func comment(
    _ id: String,
    author: String,
    body: String = "A reply.",
    root: String? = nil,
    spoiler: Bool = false,
    removed: Bool = false,
    unavailable: Bool = false,
    addressed: String? = nil
  ) -> JSONValue {
    [
      "id": .string(id),
      "body": .string(body),
      "photo": .null,
      "removed": .bool(removed),
      "root_id": .orNull(root),
      "spoiler": .bool(spoiler),
      "username": unavailable ? .null : .string(author),
      "author_id": unavailable ? .null : .string("user-\(author)"),
      "reactions": [],
      "created_at": "2026-10-13T12:00:00.000000+00:00",
      "unavailable": .bool(unavailable),
      "display_name": unavailable ? .null : .string(author.capitalized),
      "addressed_username": .orNull(addressed),
    ]
  }
}

struct FeedFixtureError: Error, CustomStringConvertible {
  let description: String
}

extension JSONValue {
  static func orNull(_ value: String?) -> JSONValue {
    guard let value else { return .null }
    return .string(value)
  }

  func member(_ key: String) -> JSONValue? {
    guard case .object(let members) = self else { return nil }
    return members[key]
  }

  func merging(_ changes: [String: JSONValue]) -> JSONValue {
    guard case .object(let members) = self else { return self }
    return .object(members.merging(changes) { _, new in new })
  }
}

// A member API that records each request and answers from a script by
// action, such as `["comment": .success(["id": "10"])]`. An action without a
// reply fails as the server's 404 would.
final class RecordingAPI: ScreenrAPI {
  enum Reply: Sendable {
    case success(JSONValue)
    case failure(APIError.Kind)
  }

  struct Sent: Hashable, Sendable {
    let method: HTTPMethod
    let action: String
    let query: [String: String]
    let body: JSONValue?
  }

  private let replies: Mutex<[String: [Reply]]>
  private let sent = Mutex<[Sent]>([])

  init(_ replies: [String: Reply] = [:]) {
    self.replies = Mutex(replies.mapValues { [$0] })
  }

  // Replies in order for one action; the last one repeats.
  init(sequences: [String: [Reply]]) {
    replies = Mutex(sequences)
  }

  var requests: [Sent] { sent.withLock { $0 } }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let action = String(request.endpoint.path.split(separator: "/").last ?? "")
    var body: JSONValue?
    if case .json(let value) = request.body { body = value }
    let record = Sent(method: request.method, action: action, query: request.query, body: body)
    let reply = sent.withLock { sent in
      sent.append(record)
      return replies.withLock { replies -> Reply? in
        guard var queue = replies[action], let first = queue.first else { return nil }
        if queue.count > 1 { queue.removeFirst() }
        replies[action] = queue
        return first
      }
    }
    let requestID = "request-\(requests.count)"
    switch reply {
    case .success(let value):
      do {
        return try ScreenrJSON.decoder()
          .decode(
            Response.self,
            from: try JSONEncoder().encode(value)
          )
      } catch {
        throw APIError(kind: .invalidResponse, requestID: requestID)
      }
    case .failure(let kind):
      throw APIError(kind: kind, message: "The \(action) failed.", requestID: requestID)
    case .none:
      throw APIError(kind: .notFound, message: "Action not found.", requestID: requestID)
    }
  }
}

// Counts the refreshes a model asks for after its writes.
@MainActor
final class RefreshCounter {
  private(set) var count = 0

  func refresh() async {
    count += 1
  }
}
