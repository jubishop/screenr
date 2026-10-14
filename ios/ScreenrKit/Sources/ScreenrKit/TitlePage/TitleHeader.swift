import Foundation

// The viewer's own place in a title page's header, read from the page: their
// Recommend, the title's rank in their top 10, their status and last-finished
// date, and their review.
public struct TitleHeader: Hashable, Sendable {
  // The most titles a member's top 10 holds.
  public static let topTenLimit = 10

  public let title: Title
  public let recommended: Bool
  // The title's rank in the viewer's top 10, or nil while it is not listed.
  public let rank: Int?
  // The viewer's whole top 10, which a full list's replacement chooses from.
  public let topTen: [TopTenEntry]
  public let status: WatchStatus?
  // `YYYY-MM-DD`.
  public let finishedOn: String?
  // The viewer's current review, which the editor starts from.
  public let review: ReviewDraft?

  public init(_ page: TitleScreen, viewer: String) {
    title = page.title
    let own = page.conversations.filter { $0.ownerId == viewer }
    recommended = own.contains { $0.recommended }
    rank = page.topTen.first { $0.id == page.title.id }?.rank
    topTen = page.topTen
    status = page.watch.status
    finishedOn = page.watch.finishedOn
    if let saved = own.first(where: { $0.itemType == .review && $0.active }) {
      review = ReviewDraft(rating: saved.rating, body: saved.body ?? "", spoiler: saved.spoiler)
    } else {
      review = nil
    }
  }

  // Adding another title asks which listed title to remove.
  public var isTopTenFull: Bool { topTen.count >= Self.topTenLimit }

  // The kind and release year, such as "Movie · 2024".
  public var details: String {
    let kind = title.kind == .tv ? "TV show" : "Movie"
    let year = title.releaseDate.prefix(4)
    return "\(kind) · \(year.isEmpty ? "Date unavailable" : year)"
  }

  public var overview: String {
    title.overview.isEmpty ? "No synopsis available." : title.overview
  }

  public var recommendLabel: String { recommended ? "Recommended" : "Recommend to friends" }

  public var topTenLabel: String {
    guard let rank else { return "Add to top 10" }
    return "#\(rank) in your top 10"
  }

  // The current status, or the first choice while there is none.
  public var statusLabel: String {
    guard let status else { return WatchStatus.wantToWatch.label }
    return status.label
  }

  public var reviewLabel: String { review == nil ? "Rate or review" : "Edit your review" }

  // The status choices: Caught up is for TV only.
  public var statusOptions: [WatchStatus] {
    title.kind == .tv
      ? [.wantToWatch, .watching, .caughtUp, .finished, .stopped]
      : [.wantToWatch, .watching, .finished, .stopped]
  }

  // The last-finished date shows while a progress status or a stored date
  // exists.
  public var showsFinishedDate: Bool {
    if finishedOn != nil { return true }
    guard let status else { return false }
    return status != .wantToWatch
  }
}

// A review's rating, text, and spoiler flag. A review needs a rating, text,
// or both.
public struct ReviewDraft: Hashable, Sendable {
  public static let maximumLength = 2_000

  // Whole stars from 1 to 5, or nil for text alone.
  public var rating: Int?
  public var body: String
  public var spoiler: Bool

  public init(rating: Int? = nil, body: String = "", spoiler: Bool = false) {
    self.rating = rating
    self.body = body
    self.spoiler = spoiler
  }

  public var isEmpty: Bool {
    rating == nil && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

// Calendar days as the server stores them, `YYYY-MM-DD`, in the reader's own
// calendar and time zone.
public enum CalendarDay {
  // The earliest last-finished date the server accepts.
  public static let earliest = "1900-01-01"

  public static func today(now: Date = .now, calendar: Calendar = .current) -> String {
    string(from: now, calendar: calendar)
  }

  public static func string(from date: Date, calendar: Calendar = .current) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    let year = String(parts.year ?? 0)
    let month = String(parts.month ?? 0)
    let day = String(parts.day ?? 0)
    return [
      String(repeating: "0", count: max(0, 4 - year.count)) + year,
      String(repeating: "0", count: max(0, 2 - month.count)) + month,
      String(repeating: "0", count: max(0, 2 - day.count)) + day,
    ]
    .joined(separator: "-")
  }

  // The start of the day, or nil for a value that names no day.
  public static func date(from value: String, calendar: Calendar = .current) -> Date? {
    let parts = value.split(separator: "-")
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]),
      let day = Int(parts[2]),
      let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
      string(from: date, calendar: calendar) == value
    else { return nil }
    return date
  }
}
