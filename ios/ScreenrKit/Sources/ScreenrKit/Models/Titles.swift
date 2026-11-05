import Foundation

// Movies and shows, where to watch them, and members' statuses for them.

public enum TitleKind: String, ServerEnum {
  case movie
  case tv
  case unknown
}

// A member's one current status for a title. Want to watch is a title action;
// the others share one progress entry, and Caught up is for TV only.
public enum WatchStatus: String, ServerEnum {
  case wantToWatch = "want_to_watch"
  case watching
  case caughtUp = "caught_up"
  case finished
  case stopped
  case unknown
}

// A movie or show. `id` is `<kind>:<TMDB ID>`, such as `tv:201`, and
// `releaseDate` is `YYYY-MM-DD`, or empty when TMDB has none.
public struct Title: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let kind: TitleKind
  public let tmdbId: Int
  public let name: String
  public let overview: String
  public let posterPath: String?
  public let releaseDate: String
}

public struct Trailer: Codable, Hashable, Sendable {
  // The YouTube video ID.
  public let key: String
  public let name: String
}

public struct Season: Codable, Hashable, Sendable {
  public let number: Int
  public let name: String
}

public struct Episode: Codable, Hashable, Sendable {
  public let number: Int
  public let name: String
}

// A title in a member's profile top 10, with its rank from 1.
public struct TopTenEntry: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let posterPath: String?
  public let rank: Int
}

// The viewer's status for a title on its page. `finishedOn` is `YYYY-MM-DD`.
public struct TitleWatch: Codable, Hashable, Sendable {
  public let status: WatchStatus?
  public let finishedOn: String?
}

// A streaming service a member can save on Account.
public struct StreamingService: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
}

public enum AvailabilityStatus: String, ServerEnum {
  case ok
  case stale
  case unavailable
  case unknown
}

public enum WatchSectionKey: String, ServerEnum {
  case subs
  case free
  case unknown
}

// One service in a "where to watch" section, such as Netflix or a channel
// reached through another service (`routeNote`, such as "via Amazon").
public struct WatchService: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let logoPath: String?
  public let routeNote: String?
}

public struct WatchSection: Codable, Hashable, Sendable {
  public let key: WatchSectionKey
  public let label: String
  public let services: [WatchService]
}

// Where a title streams in the US, on its title page.
public struct WatchAvailability: Codable, Hashable, Sendable {
  public let status: AvailabilityStatus
  public let checkedAt: Date?
  // TMDB's watch page for the title.
  public let link: String?
  public let sections: [WatchSection]
}

// The short form of availability that title lists carry.
public struct TitleViewing: Codable, Hashable, Sendable {
  public let status: AvailabilityStatus
  public let checkedAt: Date?
  public let sections: [WatchSection]
}

// Whether the server could load a title's US release dates.
public enum ReleaseStatus: String, ServerEnum {
  case ok
  case unavailable
  case unknown
}

// Which release an upcoming date is. Clients show its label whatever the kind.
public enum ReleaseKind: String, ServerEnum {
  case theatrical
  case digital
  case premiere
  case seasonPremiere = "season_premiere"
  case unknown
}

// An upcoming US release. `date` is a calendar date, `YYYY-MM-DD`, and
// `label` the server's words for it, such as "Digital Dec 9".
public struct ReleaseDate: Codable, Hashable, Sendable {
  public let kind: ReleaseKind
  public let date: String
  public let label: String
}

// A title's US release status, which the server derives for today: whether a
// movie is in theaters, and its upcoming dates in date order.
public struct TitleRelease: Codable, Hashable, Sendable {
  public let status: ReleaseStatus
  public let inTheaters: Bool
  public let upcoming: [ReleaseDate]
}

// TMDB's user score, the average rating TMDB members give a title, as the
// whole percentage the server rounded it to, such as 73 for 7.3 out of 10.
// The server sends none when too few members rated the title, and the app
// never computes one.
public struct TMDBScore: Codable, Hashable, Sendable {
  public let percent: Int

  public init(from decoder: any Decoder) throws {
    percent = try decoder.singleValueContainer().decode(Int.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(percent)
  }
}

// What a link or text shared to the share extension names: its title, or,
// when it names none, the text the extension's search starts from, which may
// be empty.
public struct TitleResolution: Decodable, Hashable, Sendable {
  public let title: Title?
  public let query: String
}

// A title with where it streams, the viewer's access to it, its release
// status, and its TMDB user score: a search result.
public struct ViewingTitle: Decodable, Hashable, Sendable, Identifiable {
  public let title: Title
  public let viewing: TitleViewing
  public let access: ViewingAccess
  public let matchingServiceIds: [String]
  public let release: TitleRelease?
  public let tmdbScore: TMDBScore?

  public var id: String { title.id }

  private enum CodingKeys: CodingKey {
    case viewing
    case access
    case matchingServiceIds
    case release
    case tmdbScore
  }

  public init(from decoder: any Decoder) throws {
    title = try Title(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    viewing = try container.decode(TitleViewing.self, forKey: .viewing)
    access = try container.decodeIfPresent(ViewingAccess.self, forKey: .access) ?? .unknown
    matchingServiceIds =
      try container.decodeIfPresent([String].self, forKey: .matchingServiceIds) ?? []
    release = try container.decodeIfPresent(TitleRelease.self, forKey: .release)
    tmdbScore = try container.decodeIfPresent(TMDBScore.self, forKey: .tmdbScore)
  }
}

// A friend named on a title, without a photo.
public struct PersonName: Codable, Hashable, Sendable {
  public let username: String
  public let displayName: String
}

// A friend who recommends a title, with its rank in their top 10.
public struct Recommender: Codable, Hashable, Sendable {
  public let username: String
  public let displayName: String
  public let rank: Int?
}

// A suggestion on Find a title, from friends' and friends of friends' activity.
public struct TitleSuggestion: Decodable, Hashable, Sendable, Identifiable {
  public let title: Title
  public let viewing: TitleViewing
  public let access: ViewingAccess
  public let matchingServiceIds: [String]
  public let release: TitleRelease?
  public let tmdbScore: TMDBScore?
  public let recommendedBy: [Recommender]
  public let wantedBy: [PersonName]
  // Friends who are Watching or Caught up.
  public let watchingBy: [PersonName]
  public let secondDegreeRecommended: Int
  public let secondDegreeWanted: Int
  public let secondDegreeWatching: Int

  public var id: String { title.id }

  private enum CodingKeys: CodingKey {
    case viewing
    case access
    case matchingServiceIds
    case release
    case tmdbScore
    case recommendedBy
    case wantedBy
    case watchingBy
    case secondDegreeRecommended
    case secondDegreeWanted
    case secondDegreeWatching
  }

  public init(from decoder: any Decoder) throws {
    title = try Title(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    viewing = try container.decode(TitleViewing.self, forKey: .viewing)
    access = try container.decodeIfPresent(ViewingAccess.self, forKey: .access) ?? .unknown
    matchingServiceIds =
      try container.decodeIfPresent([String].self, forKey: .matchingServiceIds) ?? []
    release = try container.decodeIfPresent(TitleRelease.self, forKey: .release)
    tmdbScore = try container.decodeIfPresent(TMDBScore.self, forKey: .tmdbScore)
    recommendedBy = try container.decode([Recommender].self, forKey: .recommendedBy)
    wantedBy = try container.decode([PersonName].self, forKey: .wantedBy)
    watchingBy = try container.decode([PersonName].self, forKey: .watchingBy)
    secondDegreeRecommended = try container.decode(Int.self, forKey: .secondDegreeRecommended)
    secondDegreeWanted = try container.decode(Int.self, forKey: .secondDegreeWanted)
    secondDegreeWatching = try container.decode(Int.self, forKey: .secondDegreeWatching)
  }
}

// A title on Friends recommend, with the viewer's own status and Recommend.
public struct FriendsRecommendation: Decodable, Hashable, Sendable, Identifiable {
  public let title: Title
  public let viewing: TitleViewing
  public let access: ViewingAccess
  public let matchingServiceIds: [String]
  public let release: TitleRelease?
  public let tmdbScore: TMDBScore?
  public let recommendedBy: [Recommender]
  public let viewerStatus: WatchStatus?
  public let viewerRecommended: Bool

  public var id: String { title.id }

  private enum CodingKeys: CodingKey {
    case viewing
    case access
    case matchingServiceIds
    case release
    case tmdbScore
    case recommendedBy
    case viewerStatus
    case viewerRecommended
  }

  public init(from decoder: any Decoder) throws {
    title = try Title(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    viewing = try container.decode(TitleViewing.self, forKey: .viewing)
    access = try container.decodeIfPresent(ViewingAccess.self, forKey: .access) ?? .unknown
    matchingServiceIds =
      try container.decodeIfPresent([String].self, forKey: .matchingServiceIds) ?? []
    release = try container.decodeIfPresent(TitleRelease.self, forKey: .release)
    tmdbScore = try container.decodeIfPresent(TMDBScore.self, forKey: .tmdbScore)
    recommendedBy = try container.decode([Recommender].self, forKey: .recommendedBy)
    viewerStatus = try container.decodeIfPresent(WatchStatus.self, forKey: .viewerStatus)
    viewerRecommended = try container.decode(Bool.self, forKey: .viewerRecommended)
  }
}

// Whether the viewer can watch a title: on one of their saved services or
// free, neither, or unknown when its viewing options could not be loaded. The
// server decides it for every title list, with the saved services that offer
// the title, and the app never does. A Find a title payload without them,
// from a server older than this build, counts as unknown and marks none.
public enum ViewingAccess: String, ServerEnum {
  case available
  case unmatched
  case unknown
}

// A title on Watch together, with the viewer's services that offer it.
public struct SharedTitle: Decodable, Hashable, Sendable, Identifiable {
  public let title: Title
  public let viewing: TitleViewing
  public let release: TitleRelease?
  public let tmdbScore: TMDBScore?
  public let access: ViewingAccess
  public let matchingServiceIds: [String]

  public var id: String { title.id }

  private enum CodingKeys: CodingKey {
    case viewing
    case release
    case tmdbScore
    case access
    case matchingServiceIds
  }

  public init(from decoder: any Decoder) throws {
    title = try Title(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    viewing = try container.decode(TitleViewing.self, forKey: .viewing)
    release = try container.decodeIfPresent(TitleRelease.self, forKey: .release)
    tmdbScore = try container.decodeIfPresent(TMDBScore.self, forKey: .tmdbScore)
    access = try container.decode(ViewingAccess.self, forKey: .access)
    matchingServiceIds = try container.decode([String].self, forKey: .matchingServiceIds)
  }
}

// A movie in an In theaters list, with its release status and TMDB user
// score but no viewing options. `release` says whether it is in US theaters
// now or its release data could not be loaded.
public struct ReleaseTitle: Decodable, Hashable, Sendable, Identifiable {
  public let title: Title
  public let release: TitleRelease
  public let tmdbScore: TMDBScore?

  public var id: String { title.id }

  private enum CodingKeys: CodingKey {
    case release
    case tmdbScore
  }

  public init(from decoder: any Decoder) throws {
    title = try Title(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    release = try container.decode(TitleRelease.self, forKey: .release)
    tmdbScore = try container.decodeIfPresent(TMDBScore.self, forKey: .tmdbScore)
  }
}
