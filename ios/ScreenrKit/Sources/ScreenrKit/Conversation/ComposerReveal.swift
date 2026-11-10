import Foundation

// What a feed scrolls into view when a composer takes focus or the keyboard
// rises over it. The system scrolls only the caret's line into view, which
// leaves the rest of the field, Contains spoilers, and Post beneath the
// keyboard. The whole composer shows when it fits in the room above the
// keyboard; otherwise the caret comes first, so its text field shows, or, for
// a field taller than the room, the system's own scroll keeps the caret in
// view.
public enum ComposerReveal: Hashable, Sendable {
  case composer
  case field
  case caret

  // The heights of the composer and its text field, and of the feed's room
  // between its bars and the keyboard, all in points.
  public init(composer: Double, field: Double, room: Double) {
    if composer <= room {
      self = .composer
    } else if field <= room {
      self = .field
    } else {
      self = .caret
    }
  }
}
