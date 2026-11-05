import Foundation
import Testing

@testable import ScreenrKit

// The windows a paged friends feed or profile reads, as the web names them.
struct HistoryWindowTests {
  private let instant = "2026-10-13T12:00:00.000Z"

  @Test func namesEachWindowInTheScreensPath() {
    #expect(HistoryWindow.newest.path("/") == "/?before=now")
    #expect(
      HistoryWindow.since(instant).path("/?item=a%20b&reply=8")
        == "/?item=a%20b&reply=8&since=2026-10-13T12%3A00%3A00.000Z"
    )
    // A window replaces the one the path named.
    #expect(
      HistoryWindow.before(instant).path("/people/ben?since=x")
        == "/people/ben?before=2026-10-13T12%3A00%3A00.000Z"
    )
    #expect(HistoryWindow.newest.path("/?before=x&since=y") == "/?before=now")
  }

  @Test func followsThePageThatAReadSent() throws {
    let newest = try #require(try screen("screen/feed/newest-page").historyPage)
    #expect(newest == HistoryPage(since: instant, older: true))
    #expect(HistoryWindow(after: newest) == .since(instant))
    #expect(newest.start == ServerTimestamp.date(from: instant))
    #expect(try screen("screen/feed/older-page").historyPage?.older == false)
    #expect(try screen("screen/profile/page").historyPage?.older == false)
    // A read without a window gets the newest page, and a screen that does
    // not page names none.
    let unwindowed = try screen("screen/feed/default").historyPage
    #expect(unwindowed == HistoryPage(since: instant, older: false))
    #expect(try screen("screen/people/default").historyPage == nil)
    #expect(HistoryWindow(after: HistoryPage(since: nil, older: false)) == .newest)
  }
}
