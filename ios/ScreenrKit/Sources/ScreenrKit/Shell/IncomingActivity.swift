import Foundation

// Which activity on a screen the reader has accepted, so a poll never moves
// what they are reading. A key names one piece of activity, such as an entry
// at its latest activity time or a reply's ID.
//
// - The first snapshot is accepted as a whole.
// - Later, other people's new keys wait behind a "New activity" or "New
//   replies" control until the reader accepts them; the screen leaves them
//   out until then.
// - The reader's own activity shows at once.
//
// Access changes, removals, and spoiler flags never wait: the screen renders
// accepted keys from the latest snapshot, so content that disappears from it
// disappears from the screen.
public struct IncomingActivity<Key: Hashable & Sendable>: Hashable, Sendable {
  private var accepted: Set<Key>?
  // Other people's activity in the latest snapshot that the reader has not
  // accepted. Its count labels the control.
  public private(set) var waiting: Set<Key> = []

  public init() {}

  public func isShown(_ key: Key) -> Bool {
    accepted?.contains(key) ?? false
  }

  // Notes the latest snapshot's keys, with the reader's own among them.
  public mutating func receive(_ keys: Set<Key>, own: Set<Key> = []) {
    guard var accepted else {
      self.accepted = keys
      return
    }
    accepted.formUnion(own.intersection(keys))
    self.accepted = accepted
    waiting = keys.subtracting(accepted)
  }

  // The reader chose the control: everything waiting shows.
  public mutating func acceptWaiting() {
    accepted = (accepted ?? []).union(waiting)
    waiting = []
  }

  // Shows one waiting key, such as an entry the reader opened from a link.
  public mutating func accept(_ key: Key) {
    guard waiting.remove(key) != nil else { return }
    accepted = (accepted ?? []).union([key])
  }
}
