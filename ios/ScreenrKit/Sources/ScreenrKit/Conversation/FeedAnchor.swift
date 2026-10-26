import Foundation

// What a feed's content begins with: its first entry, or a header above the
// entries, such as a title page's details or an open composer.
public enum FeedStart: Hashable, Sendable {
  case entries
  case header
}

// How New activity keeps the reader's place, as the web keeps the first entry
// on screen where it is while entries arrive above it. The scroll view keeps
// still whatever its scroll position names. Once the reader scrolls, that is
// the entry at the top of the screen; before, it names nothing and the scroll
// view keeps its offset. Just before the activity shows, this decides what the
// position should name.
public enum FeedAnchor: Hashable, Sendable {
  // The position already names the reader's place, or the reader is in the
  // header, which stays put on its own.
  case kept
  // Name this entry, the first, which starts the screen before the reader
  // scrolls, so it stays there.
  case pin(FeedScrollTarget)
  // Name nothing, so the header on screen stays put: the position names an
  // entry off screen, beneath a header that fills the screen.
  case release

  // `named` is what the scroll position names, `visible` the entries on
  // screen, `first` the feed's first entry, and `start` what its content
  // begins with.
  public init(
    named: FeedScrollTarget?,
    visible: Set<FeedScrollTarget>,
    first: FeedScrollTarget?,
    start: FeedStart
  ) {
    switch named {
    // A reply that a link scrolled to, which stays where the link showed it.
    case .comment:
      self = .kept
    case .entry(let entry):
      self = visible.contains(.entry(entry)) ? .kept : .release
    case nil:
      if start == .entries, let first, visible.contains(first) {
        self = .pin(first)
      } else {
        self = .kept
      }
    }
  }
}
