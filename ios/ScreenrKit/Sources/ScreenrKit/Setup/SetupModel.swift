import Foundation
import Observation

// First-time setup, as on the web: a display name and a username, which every
// member needs, and an optional photo. Joining sends the pending invitation,
// which the server uses up as it makes the new member its creator's friend.
// The server words every problem with the name, username, or invitation.
@MainActor
@Observable
public final class SetupModel {
  public enum Activity: Hashable, Sendable {
    case idle
    case joining
  }

  public var name = ""
  public var username = ""
  public private(set) var activity = Activity.idle
  // What went wrong with the last attempt, in words for the member.
  public private(set) var failure: String?
  // The optional photo, which saves as soon as the member chooses it.
  public let photo: ProfilePhotoModel

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let invitation: PendingInvitation
  @ObservationIgnored private let onJoined: @MainActor () async -> Void

  // `onJoined` runs once setup succeeds, such as to show the app.
  public init(
    api: any ScreenrAPI,
    invitation: PendingInvitation,
    onJoined: @escaping @MainActor () async -> Void
  ) {
    self.api = api
    self.invitation = invitation
    self.onJoined = onJoined
    photo = ProfilePhotoModel(api: api)
  }

  public var canJoin: Bool {
    activity == .idle && Self.hasText(name) && Self.hasText(username)
  }

  // Starts from the name the sign-in gave the account, unless the member has
  // typed one, and from the account's photo, such as a Google signup's copy.
  // Setup works without them, so a failed read leaves the fields as they are.
  public func load() async {
    do throws(APIError) {
      let details = try await api.send(.setupDetails)
      if name.isEmpty { name = details.name }
      photo.show(userId: details.userId, version: details.photo, google: details.google)
    } catch {
      return
    }
  }

  public func join() async {
    guard canJoin else { return }
    activity = .joining
    failure = nil
    defer { activity = .idle }
    do throws(APIError) {
      _ = try await api.send(
        .setup(name: name, username: username, invitation: invitation.token)
      )
    } catch {
      failure = error.explanation(otherwise: "Could not finish setting up. Try again.")
      // The server refuses an invitation that is no longer available. Asking
      // about it again forgets one that is gone.
      if error.kind == .forbidden { await invitation.recheck(using: api) }
      return
    }
    invitation.finish()
    await onJoined()
  }

  private static func hasText(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
