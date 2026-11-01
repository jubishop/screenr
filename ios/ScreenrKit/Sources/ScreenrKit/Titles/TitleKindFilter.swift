import Foundation

// The All, Movies, and TV filter on Watch together and Want to watch pages.
// All is the default, and each choice keeps the list's order.
public enum TitleKindFilter: String, Hashable, Sendable, CaseIterable, Identifiable {
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

  func includes(_ title: Title) -> Bool {
    switch self {
    case .all: true
    case .movies: title.kind == .movie
    case .tv: title.kind == .tv
    }
  }
}
