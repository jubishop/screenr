import Foundation
import Observation

// Creating and revoking invitation links, under the web's rules: a link
// allows 1 to 12 signups, 1 by default, and works for 30 days. Signing up
// through it makes the new member the creator's friend. The list shows only
// links that still work, so a revoked link leaves it.
@MainActor
@Observable
public final class InvitationsModel {
  public enum State: Hashable, Sendable {
    case idle
    case creating
    // Revoking the invitation with this ID.
    case revoking(String)
  }

  public static let signupLimits = 1...12

  // The new link's maximum signups, within `signupLimits`.
  public var limit = 1
  public private(set) var state = State.idle
  // What the last change did, such as creating a link.
  public private(set) var status: String?
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let onChange: @MainActor () async -> Void

  // `onChange` reads the screen again, which lists the new link or drops a
  // revoked one.
  public init(api: any ScreenrAPI, onChange: @escaping @MainActor () async -> Void) {
    self.api = api
    self.onChange = onChange
  }

  public var canCreate: Bool { state == .idle && Self.signupLimits.contains(limit) }

  public func create() async {
    guard canCreate else { return }
    state = .creating
    status = nil
    failure = nil
    defer { state = .idle }
    do {
      _ = try await api.send(.invite(limit: limit))
    } catch {
      report(error, otherwise: "The invitation could not be created. Try again.")
      return
    }
    await onChange()
    status = "Invitation created. Share its link with the friends you want to invite."
  }

  public func revoke(_ invitation: Invitation) async {
    guard state == .idle else { return }
    state = .revoking(invitation.id)
    status = nil
    failure = nil
    defer { state = .idle }
    do {
      _ = try await api.send(.revokeInvite(id: invitation.id))
    } catch {
      report(error, otherwise: "The invitation could not be revoked. Try again.")
      return
    }
    await onChange()
    status = "Invitation revoked. Its link no longer works."
  }

  private func report(_ error: APIError, otherwise fallback: String) {
    guard error.kind != .cancelled else { return }
    failure = error.explanation(otherwise: fallback)
  }
}

extension Invitation {
  // The invitation link, such as `https://screenr.club/join/<token>`.
  public var link: URL? { URL(string: url) }

  public var remainingUses: Int { max(maxUses - uses, 0) }
}
