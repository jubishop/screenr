import DeclaredAgeRange
import ScreenrKit
import UIKit

// Apple's Declared Age Range service for the age check. As Apple's guide
// directs, it first asks whether the law where the person is requires the
// check, then requests the age range, which shows Apple's sheet over the
// app's window where the person chooses whether to share it. In the iOS 27
// Simulator, the service says the law never requires it.
//
// The service isn't Sendable and its calls run off the main actor, so these
// functions call it off the main actor too. SwiftUI's request action isn't
// Sendable either, so the window's view controller, which is, presents the
// sheet instead.
struct SystemAgeAssurance: AgeAssurance {
  struct NoWindow: Error {}

  func isRequired() async throws -> Bool {
    try await Self.isEligible()
  }

  func declaredAge(gate: Int) async throws -> DeclaredAge {
    let scene = UIApplication.shared.connectedScenes.lazy.compactMap { $0 as? UIWindowScene }
      .first
    guard var controller = (scene?.keyWindow ?? scene?.windows.first)?.rootViewController else {
      throw NoWindow()
    }
    while let presented = controller.presentedViewController { controller = presented }
    return try await Self.request(gate: gate, in: controller)
  }

  @concurrent nonisolated private static func isEligible() async throws -> Bool {
    try await AgeRangeService.shared.isEligibleForAgeFeatures
  }

  @concurrent nonisolated private static func request(
    gate: Int,
    in controller: UIViewController
  ) async throws -> DeclaredAge {
    switch try await AgeRangeService.shared.requestAgeRange(ageGates: gate, in: controller) {
    case .declinedSharing: .declined
    case .sharing(let range): .shared(lowerBound: range.lowerBound)
    // A response this build doesn't know shares no age it can read.
    @unknown default: .declined
    }
  }
}
