import Foundation

// One of a Want to watch page's sections: the owner's titles the viewer can
// watch now, or those whose availability is unknown, in the server's
// newest-first order. The server leaves out the rest.
public struct WantToWatchSection: Hashable, Sendable, Identifiable {
  public let access: ViewingAccess
  public let titles: [SharedTitle]

  public var id: ViewingAccess { access }

  public var heading: String {
    access == .unknown ? "Availability unknown" : "Ready to watch"
  }

  public var description: String {
    access == .unknown
      ? "We could not confirm viewing options for these titles." : "On your services or free."
  }
}

// Why a Want to watch page shows nothing to watch, with whether to offer
// Find a title.
public struct WantToWatchEmpty: Hashable, Sendable {
  public let title: String
  public let message: String
  public let offersFind: Bool
}

// A profile's Want to watch page, in the web's words and order. `viewer` is
// the signed-in member's user ID, which tells their own page from a
// friend's.
extension WantToWatchScreen {
  public static let servicesPrompt = WatchTogetherScreen.servicesPrompt

  public func introduction(viewer: String) -> String {
    let wants = owner.userId == viewer ? "you want" : "\(owner.displayName) wants"
    return "Titles \(wants) to watch that are on your services or free, newest first."
  }

  public func titles(_ filter: TitleKindFilter) -> [SharedTitle] {
    titles.filter { filter.includes($0.title) }
  }

  // Ready to watch for `.available`, and Availability unknown for
  // `.unknown`, or nil while the filter leaves it no titles.
  public func section(_ access: ViewingAccess, _ filter: TitleKindFilter) -> WantToWatchSection? {
    let matches = titles(filter).filter { $0.access == access }
    return matches.isEmpty ? nil : WantToWatchSection(access: access, titles: matches)
  }

  // "2 titles to watch now", counting only the titles ready to watch.
  public func count(_ filter: TitleKindFilter) -> String {
    let count = titles(filter).count(where: { $0.access == .available })
    return "\(count) \(count == 1 ? "title" : "titles") to watch now"
  }

  // Nil while the filter shows a title ready to watch. Titles whose
  // availability is unknown still show beneath the message.
  public func empty(_ filter: TitleKindFilter, viewer: String) -> WantToWatchEmpty? {
    let own = owner.userId == viewer
    if !hasWantToWatch {
      return WantToWatchEmpty(
        title: "No Want to watch titles yet.",
        message: own
          ? "When you add titles to Want to watch, the ones you can watch now appear here."
          : "When \(owner.displayName) adds titles to Want to watch, the ones you can watch now "
            + "appear here.",
        offersFind: own
      )
    }
    if !titles.contains(where: { $0.access == .available }) {
      return WantToWatchEmpty(
        title: "Nothing to watch right now.",
        message: own
          ? "None of your Want to watch titles are on your services or free right now."
          : "None of \(owner.displayName)’s Want to watch titles are on your services or free "
            + "right now.",
        offersFind: false
      )
    }
    guard section(.available, filter) == nil else { return nil }
    return WantToWatchEmpty(
      title: "No \(filter == .movies ? "movies" : "TV shows") to watch right now.",
      message: "Try All to see the other titles you can watch.",
      offersFind: false
    )
  }

  // The title page a title opens. Its Want to watch save reports the
  // `title` surface, as the web's links from this page do.
  public static func destination(of title: SharedTitle) -> Destination {
    .title(id: title.id)
  }
}
