import Foundation

// How a title page's friend line and viewing options read, in the web's words.

// A piece of the friend line: its words, or a friend's name, which shows that
// friend's entry in the feed below.
public enum FriendLinePart: Hashable, Sendable {
  case text(String)
  case name(FriendAction)
}

// The friend line's parts as the pieces a wrapping row lays out: each word
// with the space after it, and each name, with whether a space follows.
public enum FriendLineToken: Hashable, Sendable {
  case word(String)
  case name(FriendAction, spaced: Bool)
}

extension FriendActivity {
  // How many names each group shows before "and N more".
  static let namedFriends = 3

  public var isEmpty: Bool { recommended.isEmpty && wantToWatch.isEmpty }

  // "Recommended by Maya Chen (#1) and Sam Okafor · Theo Park wants to
  // watch": recommenders first, with a recommender's top 10 rank after their
  // name, up to three names in each group, and nothing without either.
  public var lineParts: [FriendLinePart] {
    Self.merged(Array(groups.joined(separator: [.text(" · ")])))
  }

  // Each group as pieces that wrap between words, as text does. On a phone
  // each group starts its own line, in place of the web's " · ".
  public var lineGroups: [[FriendLineToken]] {
    groups.map { Self.tokens(Self.merged($0)) }
  }

  // Recommenders, then those who want to watch.
  private var groups: [[FriendLinePart]] {
    var groups: [[FriendLinePart]] = []
    if !recommended.isEmpty {
      groups.append([.text("Recommended by ")] + Self.names(recommended))
    }
    if !wantToWatch.isEmpty {
      let verb = wantToWatch.count == 1 ? " wants to watch" : " want to watch"
      groups.append(Self.names(wantToWatch) + [.text(verb)])
    }
    return groups
  }

  // Adjacent words share one part.
  private static func merged(_ parts: [FriendLinePart]) -> [FriendLinePart] {
    parts.reduce(into: []) { merged, part in
      if case .text(let next) = part, case .text(let previous)? = merged.last {
        merged[merged.count - 1] = .text(previous + next)
      } else {
        merged.append(part)
      }
    }
  }

  // A space belongs to the piece before it, so no line starts with one.
  private static func tokens(_ parts: [FriendLinePart]) -> [FriendLineToken] {
    var tokens: [FriendLineToken] = []
    for part in parts {
      switch part {
      case .name(let friend):
        tokens.append(.name(friend, spaced: false))
      case .text(let text):
        if text.hasPrefix(" "), case .name(let friend, _)? = tokens.last {
          tokens[tokens.count - 1] = .name(friend, spaced: true)
        }
        let words = text.split(separator: " ", omittingEmptySubsequences: true)
        for (index, word) in words.enumerated() {
          let spaced = index < words.count - 1 || text.hasSuffix(" ")
          tokens.append(.word(String(word) + (spaced ? " " : "")))
        }
      }
    }
    return tokens
  }

  // The whole line as one sentence, for VoiceOver.
  public var sentence: String {
    lineParts.map { part in
      switch part {
      case .text(let text): text
      case .name(let friend): friend.displayName
      }
    }
    .joined()
  }

  // "A", "A and B", "A, B, and C", or "A, B, C, and 2 more".
  private static func names(_ people: [FriendAction]) -> [FriendLinePart] {
    var items: [[FriendLinePart]] = people.prefix(namedFriends)
      .map { person in
        guard let rank = person.rank else { return [.name(person)] }
        return [.name(person), .text(" (#\(rank))")]
      }
    let others = people.count - items.count
    if others > 0 { items.append([.text("\(others) more")]) }
    var parts: [FriendLinePart] = []
    for (index, item) in items.enumerated() {
      if index > 0 {
        let separator =
          items.count == 2 ? " and " : index == items.count - 1 ? ", and " : ", "
        parts.append(.text(separator))
      }
      parts += item
    }
    return parts
  }
}

extension WatchAvailability {
  // Why the options are missing or old, or nil when they are current.
  public var notice: String? {
    switch status {
    case .unavailable: "Viewing options could not be loaded. Please check again later."
    case .stale: "Could not refresh viewing options."
    default: nil
    }
  }

  // What shows in place of the services when none are listed, or nil.
  public var emptyMessage: String? {
    guard status != .unavailable, sections.isEmpty else { return nil }
    return status == .stale
      ? "No subscription or free options were listed when last checked."
      : "No subscription or free options are listed for the US."
  }

  // "Last checked Oct 13, 2026 at 5:00 AM PDT.", or nil without a check or
  // when the options could not be loaded.
  public func checkedLabel(timeZone: TimeZone = .current) -> String? {
    guard status != .unavailable, let checkedAt else { return nil }
    let style = Date.FormatStyle(locale: Locale(identifier: "en_US"), timeZone: timeZone)
      .month(.abbreviated).day().year().hour().minute().timeZone(.specificName(.short))
    return "Last checked \(checkedAt.formatted(style))."
  }
}
