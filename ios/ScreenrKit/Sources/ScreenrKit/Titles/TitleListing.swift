import Foundation

// What a title list shows for each title, in the web's words: its kind and
// year, its release status and TMDB user score, and where it streams, with
// the saved services that the server found offer it marked.

extension Title {
  // The kind and release year, such as "TV show · 2022", or only the kind
  // when the release date is unknown.
  public var kindAndYear: String {
    let name = kind == .movie ? "Movie" : "TV show"
    let year = releaseDate.prefix(4)
    return year.isEmpty ? name : "\(name) · \(year)"
  }
}

extension TitleRelease {
  // The status that title lists and Where to watch show, such as "In theaters
  // · Digital Nov 20": In theaters, then each upcoming date's label, as the
  // server worded them. Nil without a label or when the dates could not load.
  public var text: String? {
    guard status == .ok else { return nil }
    let labels = (inTheaters ? ["In theaters"] : []) + upcoming.map(\.label)
    return labels.isEmpty ? nil : labels.joined(separator: " · ")
  }
}

extension TMDBScore {
  // The score beside the TMDB logo, such as "73%".
  public var text: String { "\(percent)%" }
}

// Whose saved services a title's streaming summary marks: the viewer's, or
// on Watch together, either person's.
public enum SavedServicesOwner: Hashable, Sendable {
  case viewer
  case eitherPerson
}

// One line of a title's streaming summary.
public enum ViewingLine: Hashable, Sendable {
  // "On Netflix, Hulu" or "Free on Tubi TV", marking the saved services.
  case offers(WatchSectionKey, [ListedService])
  // "Viewing options unknown."
  case unknown
  // "Included in your saved services", or "Included in either person’s saved
  // services" on Watch together.
  case includesSavedServices(SavedServicesOwner)
  // "No subscription or free options listed."
  case noOptions
  // "Older availability. Check title details."
  case stale
}

// A service in a title's summary, and whether it is a saved service.
public struct ListedService: Hashable, Sendable {
  public let name: String
  public let saved: Bool

  public init(name: String, saved: Bool) {
    self.name = name
    self.saved = saved
  }
}

extension ViewingLine {
  // The words before an offer's services.
  public static func prefix(of key: WatchSectionKey) -> String {
    key == .free ? "Free on " : "On "
  }

  // The line as the web words it. Views mark saved services in an offer.
  public var text: String {
    switch self {
    case .offers(let key, let services):
      Self.prefix(of: key) + services.map(\.name).joined(separator: ", ")
    case .unknown: "Viewing options unknown."
    case .includesSavedServices(.viewer): "Included in your saved services"
    case .includesSavedServices(.eitherPerson): "Included in either person’s saved services"
    case .noOptions: "No subscription or free options listed."
    case .stale: "Older availability. Check title details."
    }
  }
}

extension TitleViewing {
  // The summary a title list shows under each title, marking
  // `matchingServices`, the saved services that the server found offer it,
  // which `owner` saved.
  public func lines(
    matchingServices: [String],
    savedBy owner: SavedServicesOwner = .viewer
  ) -> [ViewingLine] {
    guard status != .unavailable else { return [.unknown] }
    var lines = sections.map { section in
      ViewingLine.offers(
        section.key,
        section.services.map {
          ListedService(name: $0.name, saved: matchingServices.contains($0.id))
        }
      )
    }
    if !matchingServices.isEmpty { lines.append(.includesSavedServices(owner)) }
    if sections.isEmpty { lines.append(.noOptions) }
    if status == .stale { lines.append(.stale) }
    return lines
  }
}
