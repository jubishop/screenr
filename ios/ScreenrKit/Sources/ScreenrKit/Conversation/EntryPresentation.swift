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
  // "finished · Oct 12", or "removed their review" for a withdrawn entry kept
  // for its replies.
  public func action(
    style: EntryStyle,
    now: Date = .now,
    calendar: Calendar = .current
  ) -> String {
    switch itemType {
    case .comment: return style == .compact ? "commented" : "commented on"
    case .post: return "posted"
    case .earlier: return "Earlier discussion"
    case .review: return !active ? "removed their review" : body == nil ? "rated" : "reviewed"
    case .progress:
      guard active else { return "removed their watch status" }
      switch status {
      case .finished:
        guard let finishedOn,
          let date = FinishedDate.label(finishedOn, now: now, calendar: calendar)
        else { return "finished" }
        return "finished · \(date)"
      case .watching: return "is watching"
      case .caughtUp: return "is caught up"
      default: return "stopped watching"
      }
    case .recommended: return active ? "recommends" : "removed their recommendation"
    case .wantToWatch: return active ? "wants to watch" : "removed Want to watch"
    case .unknown: return "shared an update"
    }
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

// A review's rating as filled and empty stars, and its spoken form.
public enum ReviewStars {
  public static func symbols(_ rating: Int) -> String {
    let filled = min(max(rating, 0), 5)
    return String(repeating: "★", count: filled) + String(repeating: "☆", count: 5 - filled)
  }

  // "3 stars out of 5", which VoiceOver reads as the rating's value.
  public static func value(_ rating: Int) -> String {
    "\(rating) star\(rating == 1 ? "" : "s") out of 5"
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
// "5m", "2h", or "3d" under a week, then "Oct 12", with the year outside the
// reader's current year. A clock running behind shows new activity as now.
public enum RelativeTime {
  public static func label(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String
  {
    let elapsed = now.timeIntervalSince(date)
    let minute = 60.0
    let hour = 60 * minute
    let day = 24 * hour
    let week = 7 * day
    if elapsed > -week, elapsed < week {
      if elapsed < minute { return "now" }
      if elapsed < hour { return "\(Int(elapsed / minute))m" }
      if elapsed < day { return "\(Int(elapsed / hour))h" }
      return "\(Int(elapsed / day))d"
    }
    let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
    let style = dayStyle(calendar)
    return sameYear ? date.formatted(style) : date.formatted(style.year())
  }

  // The full local date and time, such as "Oct 12, 2026 at 3:05 PM", which
  // VoiceOver reads in place of the short form.
  public static func fullDate(_ date: Date, calendar: Calendar = .current) -> String {
    date.formatted(dayStyle(calendar).year().hour().minute())
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

// A last-finished date is a calendar day, `YYYY-MM-DD`, shown without time
// zone conversion, such as "Oct 12", with the year outside the current one.
public enum FinishedDate {
  private static let months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"
    .split(separator: " ")

  public static func label(_ value: String, now: Date = .now, calendar: Calendar = .current)
    -> String?
  {
    let parts = value.split(separator: "-")
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]),
      let day = Int(parts[2]), months.indices.contains(month - 1)
    else { return nil }
    let label = "\(months[month - 1]) \(day)"
    return year == calendar.component(.year, from: now) ? label : "\(label), \(year)"
  }
}
