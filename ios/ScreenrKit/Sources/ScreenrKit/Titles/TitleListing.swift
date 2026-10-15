import Foundation

// What a title list shows for each title, in the web's words: its kind and
// year, and where it streams, with the viewer's saved services marked.

extension Title {
  // The kind and release year, such as "TV show · 2022", or only the kind
  // when the release date is unknown.
  public var kindAndYear: String {
    let name = kind == .movie ? "Movie" : "TV show"
    let year = releaseDate.prefix(4)
    return year.isEmpty ? name : "\(name) · \(year)"
  }
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

  // The line for VoiceOver, which names each saved service as saved.
  public var spokenText: String {
    guard case .offers(let key, let services) = self else { return text }
    return Self.prefix(of: key)
      + services.map { $0.saved ? "\($0.name) (saved)" : $0.name }.joined(separator: ", ")
  }
}

extension TitleViewing {
  // The viewer's saved subscription services that offer the title. Free
  // options need no saved service.
  public func matchingServices(_ serviceIds: [String]) -> [String] {
    let subscriptions = sections.first { $0.key == .subs }?.services ?? []
    return subscriptions.filter { serviceIds.contains($0.id) }.map(\.id)
  }

  // Whether the viewer can watch the title on a saved service or for free.
  public func access(for serviceIds: [String]) -> ViewingAccess {
    guard status != .unavailable else { return .unknown }
    let free = sections.contains { $0.key == .free && !$0.services.isEmpty }
    return !matchingServices(serviceIds).isEmpty || free ? .available : .unmatched
  }

  // The summary a title list shows under each title, marking the services
  // that `owner` saved.
  public func lines(
    savedServices serviceIds: [String],
    savedBy owner: SavedServicesOwner = .viewer
  ) -> [ViewingLine] {
    guard status != .unavailable else { return [.unknown] }
    let owned = matchingServices(serviceIds)
    var lines = sections.map { section in
      ViewingLine.offers(
        section.key,
        section.services.map { ListedService(name: $0.name, saved: owned.contains($0.id)) }
      )
    }
    if !owned.isEmpty { lines.append(.includesSavedServices(owner)) }
    if sections.isEmpty { lines.append(.noOptions) }
    if status == .stale { lines.append(.stale) }
    return lines
  }
}
