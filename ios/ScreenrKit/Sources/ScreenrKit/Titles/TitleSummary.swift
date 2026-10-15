import Foundation

// A movie or show as Siri, the Shortcuts app, and Spotlight show it: its name,
// kind and year, and poster. `id` is the API's title ID, such as `tv:201`.
public struct TitleSummary: Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let kind: TitleKind
  // `YYYY-MM-DD`, or empty when TMDB has none.
  public let releaseDate: String
  public let posterPath: String?

  public init(
    id: String,
    name: String,
    kind: TitleKind,
    releaseDate: String = "",
    posterPath: String? = nil
  ) {
    self.id = id
    self.name = name
    self.kind = kind
    self.releaseDate = releaseDate
    self.posterPath = posterPath
  }

  public init(_ title: Title) {
    self.init(
      id: title.id,
      name: title.name,
      kind: title.kind,
      releaseDate: title.releaseDate,
      posterPath: title.posterPath
    )
  }

  // An entry's movie or show, or nil for a post without one.
  init?(_ item: FeedItem) {
    guard let id = item.titleId, let name = item.titleName else { return nil }
    self.init(
      id: id,
      name: name,
      kind: item.kind ?? Self.kind(of: id),
      releaseDate: item.releaseDate ?? "",
      posterPath: item.posterPath
    )
  }

  // "Movie · 2024", as title lists word it.
  public var details: String {
    let kind = kind == .movie ? "Movie" : "TV show"
    let year = releaseDate.prefix(4)
    return year.isEmpty ? kind : "\(kind) · \(year)"
  }

  // The title page.
  public var destination: Destination { .title(id: id) }

  // Whether `id` names a movie or show, such as `movie:101` or `tv:201`. An
  // identifier that Spotlight or the Shortcuts app kept is checked with this
  // before it opens a page or reaches the server.
  public static func isTitleID(_ id: String) -> Bool {
    let parts = id.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2, ["movie", "tv"].contains(parts[0]) else { return false }
    return !parts[1].isEmpty && parts[1].allSatisfy { $0.isASCII && $0.isNumber }
  }

  private static func kind(of id: String) -> TitleKind {
    id.hasPrefix("tv:") ? .tv : .movie
  }
}
