import Foundation
import SwiftUI
import Synchronization

// Marks the app's visits for usage telemetry. The first `screen` read after
// launch, and the first after each return from the background, sends
// `Screenr-Visit: 1`, and the server records the member's day for it as it
// does for a page load on the website. Polls and other reads send nothing.
//
// One read carries the visit at a time. When the server does not answer it,
// such as offline or before setup, the next screen read carries it instead.
// The app reports its scene phase; the client asks for the visit.
public final class VisitTracker: Sendable {
  // A screen read that carries the visit.
  struct Visit: Hashable, Sendable {
    let number: Int
  }

  private enum State: Hashable {
    // The next screen read is the visit.
    case due
    case sending(Visit)
    // The server answered the visit, so no read is one until the app returns.
    case recorded
    // In the background, where no read is a visit until the app returns.
    case away
  }

  private struct Storage {
    var state = State.due
    var sent = 0
  }

  private let storage = Mutex(Storage())

  public init() {}

  // Coming back from the background makes the next screen read a visit. A
  // pause in the foreground, such as Control Center, does not.
  public func sceneChanged(to phase: ScenePhase) {
    storage.withLock { storage in
      switch phase {
      case .background:
        storage.state = .away
      case .active:
        if storage.state == .away { storage.state = .due }
      case .inactive:
        break
      @unknown default:
        break
      }
    }
  }

  // The visit for a screen read about to be sent, or nil when none is due.
  func startRead() -> Visit? {
    storage.withLock { storage in
      guard storage.state == .due else { return nil }
      storage.sent += 1
      let visit = Visit(number: storage.sent)
      storage.state = .sending(visit)
      return visit
    }
  }

  // The visit's read ended with this HTTP status, or nil without a response.
  // A success or 304 recorded the day; otherwise the visit stays due. A read
  // that ends after the app left and came back changes nothing.
  func finish(_ visit: Visit, status: Int?) {
    storage.withLock { storage in
      guard storage.state == .sending(visit) else { return }
      switch status {
      case .some(200..<300), .some(304): storage.state = .recorded
      default: storage.state = .due
      }
    }
  }
}
