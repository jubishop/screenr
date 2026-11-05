import Foundation

// How the share extension ends its host app's request, which releases the
// extension's view controller. Close completes it, and the host closes its
// share sheet too. A swipe down cancels it as the member's choice, since iOS
// then shows the host's share sheet again, where the member can pick another
// app.
public enum ShareEnding: String, Hashable, Sendable {
  case completed
  case cancelled
}

// Where the share extension reports how it ended its host's request: under
// the fixture API, the request log, as `SHARE completed` or
// `SHARE cancelled`, so UI tests can check it, and otherwise nowhere.
public struct ShareEndings: Sendable {
  private let record: (@Sendable (ShareEnding) throws -> Void)?

  public static let none = ShareEndings(record: nil)

  static func recording(_ record: @escaping @Sendable (ShareEnding) throws -> Void)
    -> ShareEndings
  {
    ShareEndings(record: record)
  }

  public func report(_ ending: ShareEnding) {
    guard let record else { return }
    do {
      try record(ending)
    } catch {
      Log.share.error("The fixture request log failed", .error(error))
    }
  }
}
