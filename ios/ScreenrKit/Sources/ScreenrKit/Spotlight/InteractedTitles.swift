import Foundation

// The titles a screen shows the viewer has interacted with: Recommended,
// ranked in their top 10, saved to Want to watch, given another watch status,
// or reviewed. Spotlight indexes them on the device.
//
// - Every feed entry with a title, in the friends feed and on profiles,
//   carries the viewer's own Recommend, status, and rank for that title.
// - A title page shows the viewer's place in its header. A page without one
//   clears the title, since the viewer withdrew whatever they had.
// - Friends recommend carries the viewer's status and Recommend.
public struct InteractedTitles: Hashable, Sendable {
  // In the screen's order, each title once.
  public private(set) var titles: [TitleSummary] = []
  // Titles the screen shows without any interaction from the viewer.
  public private(set) var cleared: [String] = []

  public init(_ screen: Screen) {
    let viewer = screen.user.userId
    switch screen.content {
    case .feed(let page):
      add(page.conversations, viewer: viewer)
    case .profile(let page):
      add(page.conversations, viewer: viewer)
    case .title(let page):
      let header = TitleHeader(page, viewer: viewer)
      let interacted =
        header.recommended || header.rank != nil || header.status != nil || header.review != nil
      if interacted {
        add(TitleSummary(page.title))
      } else {
        cleared.append(page.title.id)
      }
    case .search(let page):
      for recommendation in page.recommendations
      where recommendation.viewerRecommended || recommendation.viewerStatus != nil {
        add(TitleSummary(recommendation.title))
      }
    case .people, .invites, .account, .watchTogether, .wantToWatch, .redirect, .unknown:
      break
    }
  }

  private mutating func add(_ items: [FeedItem], viewer: String) {
    for item in items where Self.interacted(item, viewer: viewer) {
      guard let title = TitleSummary(item) else { continue }
      add(title)
    }
  }

  private mutating func add(_ title: TitleSummary) {
    guard !titles.contains(where: { $0.id == title.id }) else { return }
    titles.append(title)
  }

  private static func interacted(_ item: FeedItem, viewer: String) -> Bool {
    if item.viewerRecommended || item.viewerWantToWatch { return true }
    if item.viewerStatus != nil || item.viewerTopTenRank != nil { return true }
    // The viewer's own review, which the entry's viewer fields leave out.
    return item.ownerId == viewer && item.active && item.itemType == .review
  }
}
