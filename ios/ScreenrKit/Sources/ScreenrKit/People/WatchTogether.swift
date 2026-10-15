import Foundation

// Watch together's All, Movies, and TV filter. All is the default, and each
// keeps the newest shared matches first.
public enum WatchTogetherFilter: String, Hashable, Sendable, CaseIterable, Identifiable {
  case all
  case movies
  case tv

  public var id: Self { self }

  public var label: String {
    switch self {
    case .all: "All"
    case .movies: "Movies"
    case .tv: "TV"
    }
  }

  func includes(_ title: SharedTitle) -> Bool {
    switch self {
    case .all: true
    case .movies: title.title.kind == .movie
    case .tv: title.title.kind == .tv
    }
  }
}

// One of Watch together's sections: the shared titles either person can
// watch now, those on neither's services, and those without known options.
public struct WatchTogetherSection: Hashable, Sendable, Identifiable {
  public let access: ViewingAccess
  public let titles: [SharedTitle]

  public var id: ViewingAccess { access }

  public var heading: String {
    switch access {
    case .available: "Ready to watch"
    case .unmatched: "Not on your services"
    case .unknown: "Availability unknown"
    }
  }

  public var description: String {
    switch access {
    case .available: "On a service either of you has, or free. Newest shared matches first."
    case .unmatched: "No listed options match your saved services or offer free viewing."
    case .unknown: "We could not confirm viewing options for these shared picks."
    }
  }
}

// Why Watch together shows no titles, with whether to offer Find a title.
public struct WatchTogetherEmpty: Hashable, Sendable {
  public let title: String
  public let message: String
  public let offersFind: Bool
}

// Watch together, in the web's words and order.
extension WatchTogetherScreen {
  public static let introduction =
    "Everything you both want to watch. Your services and free options first, then your "
    + "other shared picks."
  public static let servicesPrompt =
    "Save your streaming services to see what you can watch right now."

  public func titles(_ filter: WatchTogetherFilter) -> [SharedTitle] {
    titles.filter(filter.includes)
  }

  // The sections with titles, each in the server's newest-first order.
  public func sections(_ filter: WatchTogetherFilter) -> [WatchTogetherSection] {
    let shown = titles(filter)
    return [ViewingAccess.available, .unmatched, .unknown]
      .compactMap { access in
        let matches = shown.filter { $0.access == access }
        return matches.isEmpty ? nil : WatchTogetherSection(access: access, titles: matches)
      }
  }

  // "2 shared titles".
  public func count(_ filter: WatchTogetherFilter) -> String {
    let count = titles(filter).count
    return "\(count) shared \(count == 1 ? "title" : "titles")"
  }

  // Nil while the filter shows titles.
  public func empty(_ filter: WatchTogetherFilter) -> WatchTogetherEmpty? {
    guard titles(filter).isEmpty else { return nil }
    if titles.isEmpty {
      return WatchTogetherEmpty(
        title: "No shared titles yet.",
        message: "When you both add a title to Want to watch, it will appear here.",
        offersFind: true
      )
    }
    return WatchTogetherEmpty(
      title: "No shared \(filter == .movies ? "movies" : "TV shows") yet.",
      message: "Try All to see your other shared choices.",
      offersFind: false
    )
  }
}
