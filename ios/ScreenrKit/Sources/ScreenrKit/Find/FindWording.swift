import Foundation

// Find a title's sentences, worded as on the web.
public enum FindWording {
  public static let tooShort = "Enter at least two characters to search."
  public static let servicesUnavailable = "Your services could not be loaded. Try refreshing."

  // Friends recommend's empty message: the titles Show finished would show,
  // or that the filters leave none.
  static func noRecommendations(
    kind: FindModel.KindFilter,
    finished: Int,
    myServices: Bool
  ) -> String {
    let noun =
      switch kind {
      case .all: "recommendation"
      case .movies: "movie recommendation"
      case .tv: "TV recommendation"
      }
    let place = myServices ? " on your services or free" : ""
    if finished > 0 {
      let which = finished == 1 ? "the only \(noun)" : "all \(finished) \(noun)s"
      let them = finished == 1 ? "it" : "them"
      return "You finished \(which)\(place). Turn on Show finished to see \(them)."
    }
    if myServices {
      return "No \(noun)s\(place). Turn off My services to see all \(noun)s."
    }
    return "No \(noun)s yet."
  }

  static func unknownViewing(_ count: Int) -> String? {
    guard count > 0 else { return nil }
    let titles = count == 1 ? "title has" : "titles have"
    let them = count == 1 ? "it" : "them"
    return
      "\(count) \(titles) unknown viewing options. Turn off My services to see \(them)."
  }
}

// What the viewer's circle did with a suggested title.
public enum SuggestionAction: Hashable, Sendable {
  case recommended
  case wantToWatch
  case watching

  // "recommends this", "are also watching", and the like.
  func phrase(singular: Bool, also: Bool) -> String {
    let extra = also ? "also " : ""
    switch self {
    case .watching: return "\(singular ? "is" : "are") \(extra)watching"
    case .recommended: return "\(extra)\(singular ? "recommends" : "recommend") this"
    case .wantToWatch: return "\(extra)\(singular ? "wants" : "want") to watch this"
    }
  }
}

extension TitleSuggestion {
  // Why the title is suggested: direct friends by name, recommenders with
  // their top 10 rank, as in "Maya Chen (#1)", and friends of friends only as
  // a count. Recommends come first, then Want to watch, then Watching.
  public var reasons: [String] {
    Self.reasons(
      recommendedBy.map(Self.ranked),
      secondDegree: secondDegreeRecommended,
      .recommended
    )
      + Self.reasons(wantedBy.map(\.displayName), secondDegree: secondDegreeWanted, .wantToWatch)
      + Self.reasons(watchingBy.map(\.displayName), secondDegree: secondDegreeWatching, .watching)
  }

  private static func ranked(_ friend: Recommender) -> String {
    guard let rank = friend.rank else { return friend.displayName }
    return "\(friend.displayName) (#\(rank))"
  }

  private static func reasons(
    _ names: [String],
    secondDegree: Int,
    _ action: SuggestionAction
  ) -> [String] {
    var reasons: [String] = []
    if !names.isEmpty {
      let phrase = action.phrase(singular: names.count == 1, also: false)
      reasons.append(names.joined(separator: ", ") + " \(phrase).")
    }
    if secondDegree > 0 {
      let people = secondDegree == 1 ? "friend of a friend" : "friends of friends"
      let phrase = action.phrase(singular: secondDegree == 1, also: !names.isEmpty)
      reasons.append("\(secondDegree) \(people) \(phrase).")
    }
    return reasons
  }
}

// Friends recommend's action for one title.
public enum RecommendationAction: Hashable, Sendable {
  // One tap saves the title to Want to watch.
  case addWantToWatch
  // The title is in Want to watch; tapping again removes it.
  case removeWantToWatch
  // The viewer's other status, which the title page changes.
  case status(WatchStatus)
  // The viewer recommends the title, which Want to watch would replace; the
  // title page changes it.
  case recommended

  // The action's words after its symbol, such as "Want to watch" or "Caught up".
  public var label: String {
    switch self {
    case .addWantToWatch, .removeWantToWatch: "Want to watch"
    case .recommended: "Recommended"
    case .status(let status):
      switch status {
      case .wantToWatch: "Want to watch"
      case .watching: "Watching"
      case .caughtUp: "Caught up"
      case .finished: "Finished"
      case .stopped: "Stopped watching"
      case .unknown: "On your list"
      }
    }
  }
}

extension FriendsRecommendation {
  public var action: RecommendationAction {
    if let viewerStatus, viewerStatus != .wantToWatch { return .status(viewerStatus) }
    if viewerRecommended { return .recommended }
    return viewerStatus == .wantToWatch ? .removeWantToWatch : .addWantToWatch
  }

  // "Recommended by Maya Chen (#1) and Sam Okafor", with each name strongly
  // emphasized and each top 10 rank after its name.
  public var recommendedByText: AttributedString {
    var text = AttributedString("Recommended by ")
    for (index, friend) in recommendedBy.enumerated() {
      text += AttributedString(Self.separator(before: index, of: recommendedBy.count))
      var name = AttributedString(friend.displayName)
      name.inlinePresentationIntent = .stronglyEmphasized
      text += name
      if let rank = friend.rank { text += AttributedString(" (#\(rank))") }
    }
    return text
  }

  // The words between names, as in "A and B" or "A, B, and C".
  private static func separator(before index: Int, of count: Int) -> String {
    guard index > 0 else { return "" }
    if count == 2 { return " and " }
    return index == count - 1 ? ", and " : ", "
  }
}
