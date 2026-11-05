import Foundation

// Which entries a paged read of the friends feed or a profile asks for, as
// on the web: the newest page, every entry whose latest activity is at or
// after the time a paged response named, or that window extended by the
// page before it. A read without a window gets the whole history, which
// builds from before paging still read.
public enum HistoryWindow: Hashable, Sendable {
  case newest
  case since(String)
  case before(String)

  // The window that reads after `page` send: everything since the time it
  // named, or the newest page again while the history has no entries.
  public init(after page: HistoryPage) {
    if let since = page.since {
      self = .since(since)
    } else {
      self = .newest
    }
  }

  // `path`, a friends feed or profile path, with this window in place of any
  // it named.
  public func path(_ path: String) -> String {
    let (key, value) =
      switch self {
      case .newest: ("before", "now")
      case .since(let time): ("since", time)
      case .before(let time): ("before", time)
      }
    let pathname = path.prefix { $0 != "?" }
    let kept = path.dropFirst(pathname.count + 1).split(separator: "&")
      .filter { pair in
        let name = pair.prefix { $0 != "=" }
        return name != "since" && name != "before"
      }
    let pair = PathEncoding.form(key) + "=" + PathEncoding.form(value)
    return pathname + "?" + (kept + [Substring(pair)]).joined(separator: "&")
  }
}

// What a paged feed or profile read sent besides its entries: `since`,
// where its window starts, or nil when the history has no entries, and
// whether older entries remain for Show older.
public struct HistoryPage: Hashable, Sendable {
  public let since: String?
  public let older: Bool

  public init(since: String?, older: Bool) {
    self.since = since
    self.older = older
  }

  // The time `since` names, which entries the page's Show older adds are no
  // newer than.
  public var start: Date? {
    guard let since else { return nil }
    return ServerTimestamp.date(from: since)
  }
}

extension Screen {
  // A paged feed or profile read's window, or nil for another screen or a
  // read of the whole history.
  public var historyPage: HistoryPage? {
    let since: String?
    let older: Bool?
    switch content {
    case .feed(let page): (since, older) = (page.since, page.older)
    case .profile(let page): (since, older) = (page.since, page.older)
    default: return nil
    }
    guard let older else { return nil }
    return HistoryPage(since: since, older: older)
  }
}
