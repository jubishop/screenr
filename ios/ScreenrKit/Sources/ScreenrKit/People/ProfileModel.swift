import Foundation
import Observation

// The viewer's relationship with the person whose profile they read.
public enum Relationship: Hashable, Sendable {
  // The viewer's own profile.
  case own
  case friend
  // The viewer asked to be friends.
  case requestSent
  // The person asked the viewer.
  case requestReceived
  case none

  public init(_ profile: Profile, viewer: String) {
    if profile.person.userId == viewer {
      self = .own
    } else if profile.acceptedAt != nil {
      self = .friend
    } else if profile.requestedBy == viewer {
      self = .requestSent
    } else if profile.requestedBy != nil {
      self = .requestReceived
    } else {
      self = .none
    }
  }

  // The action beneath the person's name: Watch together with a friend, or
  // the friend request's next step. The viewer's own profile has none.
  public var action: ProfileAction? {
    switch self {
    case .own: nil
    case .friend: .watchTogether
    case .requestSent: .cancelRequest
    case .requestReceived: .acceptRequest
    case .none: .sendRequest
    }
  }

  // More actions: Unfriend for a friend, and Block for anyone else.
  public var menu: [ProfileMenuItem] {
    switch self {
    case .own: []
    case .friend: [.unfriend, .block]
    case .requestSent, .requestReceived, .none: [.block]
    }
  }
}

public enum ProfileAction: Hashable, Sendable {
  // A link to `/watch-together?with=<username>`.
  case watchTogether
  case cancelRequest
  case acceptRequest
  case sendRequest

  public var label: String {
    switch self {
    case .watchTogether: "Watch together"
    case .cancelRequest: "Cancel friend request"
    case .acceptRequest: "Accept friend request"
    case .sendRequest: "Send friend request"
    }
  }

  var relationship: RelationshipAction? {
    switch self {
    case .watchTogether: nil
    case .cancelRequest: .remove
    case .acceptRequest: .accept
    case .sendRequest: .request
    }
  }
}

public enum ProfileMenuItem: Hashable, Sendable {
  case unfriend
  case block

  public var label: String {
    switch self {
    case .unfriend: "Unfriend"
    case .block: "Block"
    }
  }
}

// Unfriend or Block, waiting for the viewer to confirm, in the web's words.
public enum ProfileConfirmation: Hashable, Sendable, Identifiable {
  case unfriend(Person)
  // Block also ends a friendship or removes a pending request.
  case block(Person, Relationship)

  public var id: ProfileMenuItem { item }

  public var item: ProfileMenuItem {
    switch self {
    case .unfriend: .unfriend
    case .block: .block
    }
  }

  public var person: Person {
    switch self {
    case .unfriend(let person), .block(let person, _): person
    }
  }

  public var title: String {
    "\(item.label) \(person.displayName)?"
  }

  public var message: String {
    switch self {
    case .unfriend:
      return "You’ll both lose access to each other’s posts and discussions."
    case .block(_, let relationship):
      let effect =
        switch relationship {
        case .friend: "This ends your friendship. "
        case .requestSent, .requestReceived: "This removes the pending friend request. "
        case .own, .none: ""
        }
      return effect
        + "You won’t see each other’s profiles, posts, or comments, and neither of you can "
        + "send a friend request until you unblock them."
    }
  }

  public var action: String { item.label }
}

// A profile's relationship actions, as on the web:
//
// - Watch together and the friend request's next step stay visible.
// - Unfriend and Block wait in More actions, and each asks first.
// - Block hides the profile, so a confirmed Block closes it, and anything
//   opened from it, on every tab, and opens Friends with "You blocked …".
//
// One action runs at a time, and the profile reads again after each, except
// Block. A failed action's message shows beneath the actions.
@MainActor
@Observable
public final class ProfileModel {
  public enum Activity: Hashable, Sendable {
    case idle
    case sending
    // Block succeeded, and Friends replaces the profile.
    case leaving
  }

  public private(set) var activity = Activity.idle
  public private(set) var failure: String?
  private var confirming: ProfileConfirmation?

  @ObservationIgnored private let shell: ShellModel
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  // Actions go through the shell's API; Block also uses its router.
  // `refresh` reads the profile again.
  public init(shell: ShellModel, refresh: @escaping @MainActor () async -> Void) {
    self.shell = shell
    self.refresh = refresh
  }

  // The open confirmation, while it still applies: a friendship that ended
  // elsewhere no longer offers Unfriend.
  public func confirmation(for relationship: Relationship) -> ProfileConfirmation? {
    if case .unfriend = confirming, relationship != .friend { return nil }
    return confirming
  }

  public func ask(_ item: ProfileMenuItem, about person: Person, _ relationship: Relationship) {
    guard activity == .idle, relationship.menu.contains(item) else { return }
    confirming =
      switch item {
      case .unfriend: .unfriend(person)
      case .block: .block(person, relationship)
      }
  }

  public func cancelConfirmation() {
    confirming = nil
  }

  // Sends the visible action's friend request change. Watch together is a
  // link, so it sends nothing.
  public func run(_ action: ProfileAction, for person: Person) async {
    guard let change = action.relationship else { return }
    await send(change, to: person)
  }

  public func confirm(_ confirmation: ProfileConfirmation) async {
    confirming = nil
    switch confirmation {
    case .unfriend(let person):
      await send(.remove, to: person)
    case .block(let person, _):
      guard await send(.block, to: person, readAgain: false) else { return }
      activity = .leaving
      leave(blocked: person)
    }
  }

  @discardableResult
  private func send(
    _ change: RelationshipAction,
    to person: Person,
    readAgain: Bool = true
  ) async -> Bool {
    guard activity == .idle else { return false }
    activity = .sending
    failure = nil
    do throws(APIError) {
      _ = try await shell.api.send(.relationship(target: person.userId, change))
    } catch {
      activity = .idle
      if error.kind != .cancelled { failure = error.explanation }
      return false
    }
    if readAgain { await refresh() }
    activity = .idle
    return true
  }

  // The person's profile and Watch together with them no longer load.
  private func leave(blocked person: Person) {
    let username = person.username.lowercased()
    shell.router.close { destination in
      switch destination {
      case .profile(let other): other.lowercased() == username
      case .watchTogether(let others): others.contains { $0.lowercased() == username }
      default: false
      }
    }
    shell.leaveNotice("You blocked \(person.displayName).", on: .people)
    shell.router.open(.people)
  }
}
