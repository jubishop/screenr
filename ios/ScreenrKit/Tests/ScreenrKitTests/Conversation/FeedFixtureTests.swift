import Foundation
import Testing

@testable import ScreenrKit

// Every friends feed fixture goes through the feed's model and presentation,
// as its screen renders it, without unknown kinds or missing text.
@MainActor
struct FeedFixtureTests {
  // Each `screen/feed` fixture with a body.
  nonisolated static let fixtures: [String] = {
    let directory = TestFixtures.directory.appending(
      path: "screen/feed",
      directoryHint: .isDirectory
    )
    do {
      return try FileManager.default.contentsOfDirectory(atPath: directory.path())
        .filter { $0.hasSuffix(".json") }
        .map { "screen/feed/" + $0.dropLast(".json".count) }
        .filter { $0 != "screen/feed/not-modified" }
        .sorted()
    } catch {
      return []
    }
  }()

  @Test func findsTheFeedFixtures() {
    #expect(
      Self.fixtures == [
        "screen/feed/default", "screen/feed/empty", "screen/feed/incoming",
        "screen/feed/joined", "screen/feed/linked-reply", "screen/feed/newest-page",
        "screen/feed/older-page", "screen/feed/page", "screen/feed/unavailable-link",
      ]
    )
  }

  // The poll a UI test sends after Alice's feed: Ben's new post waits behind
  // New activity, and nothing else changes.
  @Test func holdsTheIncomingPostBehindNewActivity() throws {
    guard case .feed(let first) = try screen("screen/feed/default").content,
      case .feed(let later) = try screen("screen/feed/incoming").content
    else {
      Issue.record("Expected feeds")
      return
    }
    let viewer = "user-alice"
    let feed = FeedModel(api: RecordingAPI()) {}
    feed.receive(first.conversations, viewer: viewer)
    feed.receive(later.conversations, viewer: viewer)
    let waiting = feed.layout(later.conversations, viewer: viewer)

    #expect(waiting.incoming == 1)
    #expect(waiting.entries == feed.layout(first.conversations, viewer: viewer).entries)
    feed.showIncoming(later.conversations, viewer: viewer)
    let shown = feed.layout(later.conversations, viewer: viewer).entries.map(\.id)
    #expect(shown == ["00000000-0000-4000-8000-000000000001"] + waiting.entries.map(\.id))
  }

  // Show older on Nora's feed: the entries the older page adds show at once,
  // while one with newer activity still waits behind New activity.
  @Test func showsTheOlderPageAtOnce() async throws {
    let first = try screen("screen/feed/newest-page")
    let page = try #require(first.historyPage)
    let newest = try FeedFixtures.entries("screen/feed/newest-page")
    var older = try FeedFixtures.entries("screen/feed/older-page")
    let viewer = "user-nora"
    var reads = 0
    let feed = FeedModel(api: RecordingAPI(), refresh: {}, showOlder: { reads += 1 })
    feed.receive(newest, viewer: viewer)
    let added = older.filter { item in !newest.contains { $0.id == item.id } }
    #expect(added.count == 6)
    #expect(feed.layout(older, viewer: viewer).incoming == added.count)

    // One of the added entries moved past the newest page's start since.
    let moved = try #require(added.last)
    let index = try #require(older.firstIndex { $0.id == moved.id })
    let later = JSONValue.string(Date(timeIntervalSince1970: 1_791_892_900).formatted(.iso8601))
    older[index] = try FeedFixtures.entry(
      moved.id,
      changing: ["activity_at": later, "visible_activity": later],
      in: "screen/feed/older-page"
    )
    await feed.showOlder(page)
    feed.receive(older, viewer: viewer)
    let layout = feed.layout(older, viewer: viewer)

    #expect(reads == 1)
    #expect(layout.incoming == 1)
    #expect(Set(layout.entries.map(\.id)) == Set(older.map(\.id)).subtracting([moved.id]))
    #expect(feed.older == .idle)
  }

  @Test(arguments: fixtures)
  func rendersEachFixture(_ fixture: String) throws {
    let screen = try screen(fixture)
    guard case .feed(let page) = screen.content else {
      Issue.record("\(fixture) is not a feed")
      return
    }
    let viewer = screen.user.userId
    let feed = FeedModel(api: RecordingAPI()) {}
    feed.receive(page.conversations, viewer: viewer)
    let layout = feed.layout(page.conversations, viewer: viewer)

    #expect(layout.incoming == 0)
    #expect(layout.entries.count <= page.conversations.count)
    if let target = page.target {
      #expect(feed.scrollTarget(target, in: layout) != nil)
    }
    #expect(page.targetUnavailable == (fixture == "screen/feed/unavailable-link"))
    for entry in layout.entries {
      let item = entry.item
      #expect(item.itemType != .unknown, "\(item.id)")
      #expect(item.kind != .unknown, "\(item.id)")
      #expect(!item.action(style: .full).isEmpty)
      #expect(!item.action(style: .compact).isEmpty)
      #expect(!RelativeTime.label(entry.visibleActivity).isEmpty)
      if item.itemType == .post {
        #expect(item.title == nil)
        #expect(item.link() == .feed(item: item.id))
      } else {
        let title = try #require(item.title, "\(item.id) has no title")
        #expect(!title.details.isEmpty)
        #expect(Destination(path: item.link().path) == item.link())
      }
      if item.itemType == .progress { #expect(item.status != .unknown) }
      if let rating = item.rating { #expect((1...5).contains(rating)) }
      for reaction in item.reactions { #expect(reaction.kind != .unknown) }
      let thread = feed.thread(
        entry,
        targetReply: page.target?.item == entry.id ? page.target?.reply : nil
      )
      for group in thread.groups {
        for comment in [group.parent] + group.replies {
          for reaction in comment.reactions { #expect(reaction.kind != .unknown) }
          if comment.isLive {
            #expect(comment.username != nil)
            #expect(comment.displayName != nil)
          }
        }
      }
    }
  }
}
