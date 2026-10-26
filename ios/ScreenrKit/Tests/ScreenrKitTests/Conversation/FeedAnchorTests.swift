import Testing

@testable import ScreenrKit

// What a feed's scroll position names just before New activity shows, so the
// entry at the top of the screen stays where it is.
struct FeedAnchorTests {
  private let first = FeedScrollTarget.entry("first")
  private let second = FeedScrollTarget.entry("second")
  private let third = FeedScrollTarget.entry("third")

  @Test func keepsTheEntryTheReaderScrolledTo() {
    let anchor = FeedAnchor(
      named: second,
      visible: [second, third],
      first: first,
      start: .entries
    )

    #expect(anchor == .kept)
  }

  @Test func keepsTheReplyALinkShowed() {
    let anchor = FeedAnchor(
      named: .comment("8"),
      visible: [second, third],
      first: first,
      start: .entries
    )

    #expect(anchor == .kept)
  }

  // A tall header, such as a title page's, fills the screen, and the scroll
  // position names the first entry beneath it.
  @Test func releasesAnEntryOffScreen() {
    let anchor = FeedAnchor(named: first, visible: [], first: first, start: .header)

    #expect(anchor == .release)
  }

  @Test func pinsTheFirstEntryBeforeTheReaderScrolls() {
    let anchor = FeedAnchor(named: nil, visible: [first, second], first: first, start: .entries)

    #expect(anchor == .pin(first))
  }

  // Before the reader scrolls, a header at the top stays put, and New
  // activity shows beneath it.
  @Test func keepsAHeaderBeforeTheReaderScrolls() {
    let anchor = FeedAnchor(named: nil, visible: [first], first: first, start: .header)

    #expect(anchor == .kept)
  }

  @Test func keepsAnEmptyFeed() {
    let anchor = FeedAnchor(named: nil, visible: [], first: nil, start: .entries)

    #expect(anchor == .kept)
  }
}
