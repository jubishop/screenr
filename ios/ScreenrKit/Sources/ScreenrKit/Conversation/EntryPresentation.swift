import Foundation

// How feed entries, comments, reactions, and times read, in the web's words.

// Friends and profile feeds show full entries; title pages show compact ones,
// without the title's poster, name, and actions, which the page header holds.
public enum EntryStyle: Hashable, Sendable {
  case full
  case compact
}

// A feed entry's movie or show.
public struct EntryTitle: Hashable, Sendable {
  public let id: String
  public let name: String
  public let kind: TitleKind
  // `YYYY-MM-DD`, or empty when TMDB has none.
  public let releaseDate: String

  // The kind and release year, such as "TV show · 2022", or only the kind.
  public var details: String {
    let kind = kind == .movie ? "Movie" : "TV show"
    let year = releaseDate.prefix(4)
    return year.isEmpty ? kind : "\(kind) · \(year)"
  }

  public var destination: Destination { .title(id: id) }
}

extension FeedItem {
  // The entry's movie or show, or nil for a post without a title.
  public var title: EntryTitle? {
    guard let titleId, let titleName, let kind else { return nil }
    return EntryTitle(id: titleId, name: titleName, kind: kind, releaseDate: releaseDate ?? "")
  }

  // Authors can delete their comments and posts; replies stay.
  public var isDeletable: Bool { itemType == .comment || itemType == .post }

  // A deleted comment or post, or a removed review, which shows no reactions.
  public var isErased: Bool { (isDeletable || itemType == .review) && !active }

  // What the author did, after their name: "recommends", "is watching",
  // "finished", or "removed their review" for a withdrawn entry kept for its
  // replies. An entry holding a card names every action in it, such as
  // "finished, reviewed, and recommends". Only the entry's or card's one time
  // follows, never the last-finished date.
  public func action(style: EntryStyle) -> String {
    if let combined, !combined.isEmpty { return cardAction(combined) }
    switch itemType {
    case .comment: return style == .compact ? "commented" : "commented on"
    case .post: return "posted"
    case .earlier: return "Earlier discussion"
    case .review: return active ? Self.reviewAction(body: body) : "removed their review"
    case .progress: return active ? Self.statusAction(status) : "removed their watch status"
    case .recommended: return active ? "recommends" : "removed their recommendation"
    case .wantToWatch: return active ? "wants to watch" : "removed Want to watch"
    case .unknown: return "shared an update"
    }
  }

  // The rating, text, and Edited flag the entry shows: a card's review's,
  // whichever of the card's entries holds it, and otherwise the entry's own.
  public var content: EntryContent {
    if itemType != .review, let review = combined?.first(where: { $0.itemType == .review }) {
      return EntryContent(rating: review.rating, body: review.body, edited: review.edited)
    }
    return EntryContent(rating: rating, body: body, edited: edited)
  }

  // The author line after their name: what they did, the entry's one time,
  // and Edited, such as "finished and reviewed · 2h · Edited".
  public func activityLine(style: EntryStyle, time: String) -> String {
    ([action(style: style), time] + (content.edited ? ["Edited"] : [])).joined(separator: " · ")
  }

  // A card's actions in a fixed order, status first, then the review, then
  // Recommend or Want to watch, joined like a sentence. Every entry in a card
  // is active.
  private func cardAction(_ others: [CombinedEntry]) -> String {
    let own = CombinedEntry(
      id: id,
      itemType: itemType,
      status: status,
      rating: rating,
      body: body,
      spoiler: spoiler,
      edited: edited
    )
    let actions = ([own] + others)
      .sorted { Self.cardOrder($0.itemType) < Self.cardOrder($1.itemType) }
      .map { entry in
        switch entry.itemType {
        case .progress: Self.statusAction(entry.status)
        case .review: Self.reviewAction(body: entry.body)
        case .recommended: "recommends"
        case .wantToWatch: "wants to watch"
        default: "shared an update"
        }
      }
    guard let last = actions.last, actions.count > 2 else {
      return actions.joined(separator: " and ")
    }
    return actions.dropLast().joined(separator: ", ") + ", and " + last
  }

  private static func cardOrder(_ type: ItemType) -> Int {
    switch type {
    case .progress: 0
    case .review: 1
    case .recommended, .wantToWatch: 2
    default: 3
    }
  }

  private static func statusAction(_ status: WatchStatus?) -> String {
    switch status {
    case .finished: "finished"
    case .watching: "is watching"
    case .caughtUp: "is caught up"
    default: "stopped watching"
    }
  }

  private static func reviewAction(body: String?) -> String {
    body == nil ? "rated" : "reviewed"
  }

  // A TV comment's label, such as "Season 2" or "Season 2, Episode 4". It
  // shows outside the spoiler cover.
  public var discussionLabel: String? {
    guard let season else { return nil }
    guard let episode else { return "Season \(season)" }
    return "Season \(season), Episode \(episode)"
  }

  // The placeholder for a deleted comment or post, which keeps its replies.
  public var removedLabel: String? {
    guard isDeletable, !active else { return nil }
    return itemType == .post ? "Post removed" : "Comment removed"
  }

  // The entry's permalink, optionally to one of its replies: its title page,
  // or for a post without a title, the friends feed.
  public func link(reply: String? = nil) -> Destination {
    guard let titleId else { return .feed(item: id, reply: reply) }
    return .title(id: titleId, item: id, reply: reply)
  }

  // Whether the viewer's Recommend of this entry's title holds a top 10 rank,
  // so withdrawing it asks first.
  public var isRankedByViewer: Bool { viewerRecommended && viewerTopTenRank != nil }
}

// What an entry's body and author line show from it, or from its card's
// review: the stars, the text, and whether a later save changed them.
public struct EntryContent: Hashable, Sendable {
  public let rating: Int?
  public let body: String?
  public let edited: Bool
}

extension Comment {
  // Neither removed nor unavailable: it has text, reactions, and actions.
  public var isLive: Bool { !removed && !unavailable }

  // A removed comment whose author deleted their account. Its heading alone
  // says it was removed.
  public var hasDeletedAuthor: Bool { !unavailable && authorId == nil }
}

extension WatchStatus {
  public var label: String {
    switch self {
    case .wantToWatch: "Want to watch"
    case .watching: "Watching"
    case .caughtUp: "Caught up"
    case .finished: "Finished"
    case .stopped: "Stopped watching"
    case .unknown: "Status"
    }
  }
}

extension ReactionKind {
  // The seven reactions, in the picker's order.
  public static let options: [ReactionKind] = [.like, .love, .care, .haha, .wow, .sad, .angry]

  public var label: String {
    switch self {
    case .like: "Like"
    case .love: "Love"
    case .care: "Care"
    case .haha: "Haha"
    case .wow: "Wow"
    case .sad: "Sad"
    case .angry: "Angry"
    case .unknown: "Reaction"
    }
  }

  public var emoji: String {
    switch self {
    case .like: "👍"
    case .love: "❤️"
    case .care: "🥰"
    case .haha: "😆"
    case .wow: "😮"
    case .sad: "😢"
    case .angry: "😡"
    case .unknown: "❔"
    }
  }
}

// A review's rating as filled and empty stars.
public enum ReviewStars {
  public static func symbols(_ rating: Int) -> String {
    let filled = min(max(rating, 0), 5)
    return String(repeating: "★", count: filled) + String(repeating: "☆", count: 5 - filled)
  }
}

// The confirmation for a title action that would take the title out of the
// viewer's top 10.
public enum TopTenLeaving: Hashable, Sendable {
  case withdraw(name: String, rank: Int)
  case switchToWantToWatch(name: String, rank: Int)

  public var message: String {
    switch self {
    case .withdraw(let name, let rank):
      "Remove your recommendation? \(name) also leaves your top 10 at #\(rank)."
    case .switchToWantToWatch(let name, let rank):
      "Switch to Want to watch? This removes your recommendation, and \(name) leaves your top 10 at #\(rank)."
    }
  }

  public var action: String {
    switch self {
    case .withdraw: "Remove recommendation"
    case .switchToWantToWatch: "Switch to Want to watch"
    }
  }
}

// Feed entries, comments, and notifications share one time format: "now",
// "5m", or "2h" from the reader's current day, then "Oct 12", with the year
// outside the reader's current year. Hours count elapsed time, and a clock
// running up to a week behind shows new activity as now.
public enum RelativeTime {
  public static func label(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String
  {
    let elapsed = now.timeIntervalSince(date)
    let minute = 60.0
    let hour = 60 * minute
    let week = 7 * 24 * hour
    let relative = elapsed < 0 ? elapsed > -week : calendar.isDate(date, inSameDayAs: now)
    if relative {
      if elapsed < minute { return "now" }
      if elapsed < hour { return "\(Int(elapsed / minute))m" }
      return "\(Int(elapsed / hour))h"
    }
    let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
    let style = dayStyle(calendar)
    return sameYear ? date.formatted(style) : date.formatted(style.year())
  }

  private static func dayStyle(_ calendar: Calendar) -> Date.FormatStyle {
    Date.FormatStyle(
      locale: Locale(identifier: "en_US"),
      calendar: calendar,
      timeZone: calendar.timeZone
    )
    .month(.abbreviated).day()
  }
}
