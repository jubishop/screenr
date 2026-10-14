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
        "screen/feed/default", "screen/feed/empty", "screen/feed/joined",
        "screen/feed/linked-reply", "screen/feed/unavailable-link",
      ]
    )
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
