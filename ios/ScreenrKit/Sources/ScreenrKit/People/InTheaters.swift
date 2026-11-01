import Foundation

// One of an In theaters list's sections: the movies in US theaters now, or
// those whose release data could not be loaded, in the server's order.
public struct InTheatersSection: Hashable, Sendable, Identifiable {
  public enum Status: Hashable, Sendable {
    case showing
    case unknown
  }

  public let status: Status
  public let titles: [ReleaseTitle]

  public var id: Status { status }

  public var heading: String {
    status == .showing ? "In theaters now" : "Availability unknown"
  }

  public var description: String {
    status == .showing
      ? "Based on US release dates. Check local theaters for showtimes."
      : "We could not load release dates for these movies."
  }
}

// Why an In theaters list has no movie in theaters, with whether to offer
// Find a title.
public struct InTheatersEmpty: Hashable, Sendable {
  public let title: String
  public let message: String
  public let offersFind: Bool
}

// An In theaters list on a Want to watch page or Watch together, in the web's
// words and order: the count, then In theaters now or why no movie is in
// theaters, then Availability unknown, which follows either.
public struct InTheatersSections: Hashable, Sendable {
  // Such as "2 movies in theaters".
  public let count: String
  // Nil without a movie in theaters.
  public let showing: InTheatersSection?
  // Nil while a movie is in theaters.
  public let empty: InTheatersEmpty?
  // Nil without a movie whose release data could not be loaded.
  public let unknown: InTheatersSection?

  // `noun` is what the count names, such as "movie" or "shared movie".
  init(_ titles: [ReleaseTitle], noun: String, empty: InTheatersEmpty) {
    let showing = titles.filter(\.release.inTheaters)
    let unknown = titles.filter { $0.release.status == .unavailable }
    count = "\(showing.count) \(noun)\(showing.count == 1 ? "" : "s") in theaters"
    self.showing = showing.isEmpty ? nil : InTheatersSection(status: .showing, titles: showing)
    self.empty = showing.isEmpty ? empty : nil
    self.unknown = unknown.isEmpty ? nil : InTheatersSection(status: .unknown, titles: unknown)
  }
}

// A Want to watch page In theaters, in the web's words. `viewer` is the
// signed-in member's user ID, which tells their own page from a friend's.
extension WantToWatchInTheatersScreen {
  public func introduction(viewer: String) -> String {
    let wants = owner.userId == viewer ? "you want" : "\(owner.displayName) wants"
    return "Movies \(wants) to watch that are in US theaters now, newest first."
  }

  public func sections(viewer: String) -> InTheatersSections {
    let own = owner.userId == viewer
    let empty =
      hasWantToWatch
      ? InTheatersEmpty(
        title: "Nothing in theaters right now.",
        message: own
          ? "None of your Want to watch movies are in US theaters now."
          : "None of \(owner.displayName)’s Want to watch movies are in US theaters now.",
        offersFind: false
      )
      : InTheatersEmpty(
        title: "No Want to watch titles yet.",
        message: own
          ? "When you add movies to Want to watch, the ones in US theaters now appear here."
          : "When \(owner.displayName) adds movies to Want to watch, the ones in US theaters "
            + "now appear here.",
        offersFind: own
      )
    return InTheatersSections(titles, noun: "movie", empty: empty)
  }

  // The title page a movie opens. Its Want to watch save reports the `title`
  // surface, as At home's titles do.
  public static func destination(of title: ReleaseTitle) -> Destination {
    .title(id: title.id)
  }
}

// Watch together In theaters, in the web's words.
extension WatchTogetherInTheatersScreen {
  public static let introduction =
    "Movies you both want to watch that are in US theaters now, newest shared first."

  public var sections: InTheatersSections {
    InTheatersSections(
      titles,
      noun: "shared movie",
      empty: InTheatersEmpty(
        title: "No shared movies in theaters.",
        message:
          "When you both want to watch a movie that is in US theaters now, it will appear here.",
        offersFind: false
      )
    )
  }

  // The title page a movie opens. Its Want to watch save reports Watch
  // together, as At home's titles do.
  public static func destination(of title: ReleaseTitle) -> Destination {
    .title(id: title.id, from: .watchTogether)
  }
}
