import Foundation
import Testing

@testable import ScreenrKit

// The New activity cases that the web's feed layout runs too, so the two
// clients lay out the same feed the same way.
struct SharedFeedLayoutTests {
  @Test func laysOutEveryCaseAsTheWebDoes() throws {
    let file = try SharedFeedLayoutCases.load()
    #expect(!file.cases.isEmpty)
    for example in file.cases {
      let snapshot = try example.snapshot.map(file.item)
      var accepted = try example.accepted.map { try AcceptedActivity($0.map(file.item)) }
      if let olderThan = example.olderThan {
        let date = try SharedFeedLayoutCases.date(olderThan)
        accepted = (accepted ?? AcceptedActivity(snapshot)).including(snapshot, through: date)
      }
      let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: file.viewer)

      let expected = try example.entries.map { entry in
        SharedFeedLayoutCases.Shown(
          id: entry.id,
          comments: entry.comments,
          visibleActivity: try SharedFeedLayoutCases.date(entry.visibleActivity)
        )
      }
      let shown = layout.entries.map { entry in
        SharedFeedLayoutCases.Shown(
          id: entry.id,
          comments: entry.comments.map(\.id),
          visibleActivity: entry.visibleActivity
        )
      }
      #expect(shown == expected, "\(example.name)")
      #expect(layout.incoming == example.incoming, "\(example.name)")
    }
  }
}

// `SharedCases/feed-layout.json`, beside the server fixtures. Each entry and
// comment there lists only the fields that differ from the file's `entry` and
// `comment`.
enum SharedFeedLayoutCases {
  struct File: Decodable {
    let viewer: String
    let entry: JSONValue
    let comment: JSONValue
    let cases: [Case]

    // A case's entry, with its comments, as the server sends it.
    func item(_ fields: JSONValue) throws -> FeedItem {
      var changes: [String: JSONValue] = [:]
      if case .object(let members) = fields { changes = members }
      if case .array(let comments)? = changes["comments"] {
        changes["comments"] = .array(comments.map { comment.merging(object($0)) })
      }
      return try FeedFixtures.decode(entry.merging(changes))
    }

    private func object(_ value: JSONValue) -> [String: JSONValue] {
      guard case .object(let members) = value else { return [:] }
      return members
    }
  }

  struct Case: Decodable {
    let name: String
    let accepted: [JSONValue]?
    let olderThan: String?
    let snapshot: [JSONValue]
    let entries: [Entry]
    let incoming: Int

    private enum CodingKeys: String, CodingKey {
      case name
      case accepted
      case olderThan = "older_than"
      case snapshot
      case entries
      case incoming
    }
  }

  struct Entry: Decodable {
    let id: String
    let comments: [String]
    let visibleActivity: String

    private enum CodingKeys: String, CodingKey {
      case id
      case comments
      case visibleActivity = "visible_activity"
    }
  }

  struct Shown: Hashable {
    let id: String
    let comments: [String]
    let visibleActivity: Date
  }

  static func load() throws -> File {
    let url = TestFixtures.directory
      .deletingLastPathComponent()
      .appending(path: "SharedCases/feed-layout.json")
    return try JSONDecoder().decode(File.self, from: try Data(contentsOf: url))
  }

  static func date(_ text: String) throws -> Date {
    guard let date = ServerTimestamp.date(from: text) else {
      throw FeedFixtureError(description: "\(text) is not a server time")
    }
    return date
  }
}
