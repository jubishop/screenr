import Foundation
import Observation

// Apple's Declared Age Range service: whether the law where the person is
// requires apps to check their age category, and the age range they share.
// The app wraps the system's service; tests and fixture launches use fakes.
@MainActor
public protocol AgeAssurance {
  // True where the law requires the app to check the person's age category.
  func isRequired() async throws -> Bool
  // Asks for the person's age range around `gate`, which can show Apple's
  // sheet where they choose whether to share it.
  func declaredAge(gate: Int) async throws -> DeclaredAge
}

// What the person shares about their age.
public enum DeclaredAge: Hashable, Sendable {
  case declined
  // The youngest age in the shared range, or nil when it starts below the
  // lowest gate. Where the law requires the check, the system bounds the
  // range by the law's age categories rather than Screenr's gate.
  case shared(lowerBound: Int?)
}

// Screenr is for people 18 or older. Where the law requires apps to check the
// age category that Apple shares, the app checks it at each launch, before
// sign-in, and refuses anyone the category doesn't show to be an adult: a
// minor, someone who declines to share, and anyone whose check fails.
// Elsewhere it never asks. The age stays in this check: the app never sends
// it to the server, keeps it, or logs it.
@MainActor
@Observable
public final class AgeCheck {
  public enum Phase: Hashable, Sendable {
    case checking
    case allowed
    case refused(Refusal)
  }

  public enum Refusal: Hashable, Sendable {
    // The shared range starts below 18.
    case minor
    // The person declined to share their age range.
    case declined
    // The check failed, such as when the service was unavailable.
    case failed
  }

  public static let minimumAge = 18

  public private(set) var phase = Phase.checking
  // The fixture launch's stand-in for Apple's service, which UI tests cannot
  // drive, or nil for the service the app passes to `check(using:)`.
  @ObservationIgnored private let fixture: (any AgeAssurance)?

  public init(fixture: (any AgeAssurance)? = nil) {
    self.fixture = fixture
  }

  // Checks once while the phase is `checking`. A check that its task's
  // cancellation interrupts leaves the phase as it was, to check again.
  public func check(using system: any AgeAssurance) async {
    guard phase == .checking else { return }
    let service = fixture ?? system
    do {
      guard try await service.isRequired() else {
        phase = .allowed
        return
      }
      switch try await service.declaredAge(gate: Self.minimumAge) {
      case .shared(let lowerBound?) where lowerBound >= Self.minimumAge:
        phase = .allowed
      case .shared:
        phase = .refused(.minor)
      case .declined:
        phase = .refused(.declined)
      }
    } catch {
      guard !Task.isCancelled else { return }
      Log.app.notice("The age check failed", .error(error))
      phase = .refused(.failed)
    }
  }

  // Checks again after a refusal, such as once the person shares their age
  // range in Settings.
  public func retry() {
    if case .refused = phase { phase = .checking }
  }
}
