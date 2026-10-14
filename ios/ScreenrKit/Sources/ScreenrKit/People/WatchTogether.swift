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

// A service in a shared title's options, and whether either person saved it.
public struct ServiceMention: Hashable, Sendable {
  public let name: String
  public let saved: Bool
}

// One line of where a shared title streams, as the web's title card words it.
public enum SharedViewingLine: Hashable, Sendable {
  // "On Hulu, Netflix" or "Free on Tubi TV", marking the saved services.
  case offers(prefix: String, services: [ServiceMention])
  // "Included in either person’s saved services".
  case saved
  // Why there is nothing to list, or that the options may be out of date.
  case note(String)

  public var text: String {
    switch self {
    case .offers(let prefix, let services): prefix + services.map(\.name).joined(separator: ", ")
    case .saved: "Included in either person’s saved services"
    case .note(let note): note
    }
  }

  // VoiceOver names each saved service as saved.
  public var spokenText: String {
    guard case .offers(let prefix, let services) = self else { return text }
    return prefix
      + services.map { $0.saved ? "\($0.name) (saved)" : $0.name }.joined(separator: ", ")
  }
}

extension SharedTitle {
  // The kind and release year, such as "TV show · 2022", or only the kind.
  public var details: String {
    let kind = title.kind == .movie ? "Movie" : "TV show"
    let year = title.releaseDate.prefix(4)
    return year.isEmpty ? kind : "\(kind) · \(year)"
  }

  // Where it streams, marking the subscription services either person saved.
  public var viewingLines: [SharedViewingLine] {
    guard viewing.status != .unavailable else { return [.note("Viewing options unknown.")] }
    let subscriptions = viewing.sections.first { $0.key == .subs }?.services ?? []
    let saved = Set(subscriptions.map(\.id)).intersection(matchingServiceIds)
    var lines = viewing.sections.map { section in
      SharedViewingLine.offers(
        prefix: section.key == .free ? "Free on " : "On ",
        services: section.services.map { service in
          ServiceMention(
            name: service.name,
            saved: section.key == .subs && saved.contains(service.id)
          )
        }
      )
    }
    if !saved.isEmpty { lines.append(.saved) }
    if viewing.sections.isEmpty { lines.append(.note("No subscription or free options listed.")) }
    if viewing.status == .stale { lines.append(.note("Older availability. Check title details.")) }
    return lines
  }
}
