import Foundation
import Observation

// Friends, `/people`, in the web's order: requests to the viewer, their
// friends, the requests they sent, People you may know, and the people they
// blocked.
public struct FriendsSections: Hashable, Sendable {
  public let requests: [Person]
  public let friends: [Person]
  public let sent: [Person]
  public let suggestions: [PersonSuggestion]
  public let blocked: [Person]

  public init(_ page: PeopleScreen, viewer: String) {
    let pending = page.connections.filter { $0.acceptedAt == nil }
    requests = pending.filter { $0.requestedBy != viewer }.map(\.person)
    friends = page.connections.filter { $0.acceptedAt != nil }.map(\.person)
    sent = pending.filter { $0.requestedBy == viewer }.map(\.person)
    suggestions = page.suggestions
    blocked = page.blocked
  }

  // A member without friends or requests in either direction, whom the page
  // tells how to start.
  public var isEmpty: Bool { requests.isEmpty && friends.isEmpty && sent.isEmpty }
}

extension PersonSuggestion {
  // "Mutual friend: " or "Mutual friends: ", before their names.
  public var mutualFriendsLabel: String {
    mutualFriends.count == 1 ? "Mutual friend: " : "Mutual friends: "
  }
}

extension Person {
  // "Ben Ortiz (@ben)", as the web names a mutual friend.
  public var nameAndUsername: String { "\(displayName) (@\(username))" }
}

// The Friends page's actions, as the web's People page sends them through
// `relationship`:
//
// - Accept and Decline answer a request; Decline asks first.
// - Cancel withdraws a request the viewer sent.
// - Send friend request asks someone the viewer may know.
// - Unblock lifts a block.
//
// One action runs at a time, and the page reads again after each. A failed
// action's message shows with its person until their next action. The exact
// username search opens that person's profile.
@MainActor
@Observable
public final class FriendsModel {
  public enum Action: Hashable, Sendable {
    case accept
    case decline
    case cancel
    case request
    case unblock

    public var label: String {
      switch self {
      case .accept: "Accept"
      case .decline: "Decline"
      case .cancel: "Cancel"
      case .request: "Send friend request"
      case .unblock: "Unblock"
      }
    }

    var relationship: RelationshipAction {
      switch self {
      case .accept: .accept
      case .decline, .cancel: .remove
      case .request: .request
      case .unblock: .unblock
      }
    }
  }

  // An action waiting for the server, which every other action waits for.
  public struct Pending: Hashable, Sendable {
    public let person: String
    public let action: Action
  }

  public private(set) var pending: Pending?
  // The request whose Decline waits for confirmation.
  public private(set) var declining: Person?
  // The exact username search's draft, which outlives a failed read.
  public var username = ""
  // Why Find opened nothing, until the next Find.
  public private(set) var searchProblem: String?
  private var failures: [String: String] = [:]

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void

  // `refresh` reads the page again after each action.
  public init(api: any ScreenrAPI, refresh: @escaping @MainActor () async -> Void) {
    self.api = api
    self.refresh = refresh
  }

  public var isSending: Bool { pending != nil }

  public func isPending(_ action: Action, for person: Person) -> Bool {
    pending == Pending(person: person.userId, action: action)
  }

  // Why the person's last action failed, in the server's words when it sent
  // them.
  public func failure(for person: Person) -> String? {
    failures[person.userId]
  }

  public func run(_ action: Action, for person: Person) async {
    guard pending == nil else { return }
    declining = nil
    failures[person.userId] = nil
    pending = Pending(person: person.userId, action: action)
    defer { pending = nil }
    do throws(APIError) {
      _ = try await api.send(.relationship(target: person.userId, action.relationship))
    } catch  where error.kind == .cancelled {
      return
    } catch {
      failures[person.userId] = error.explanation
      return
    }
    await refresh()
  }

  public func askToDecline(_ person: Person) {
    guard pending == nil else { return }
    declining = person
  }

  public func cancelDecline() {
    declining = nil
  }

  // The profile to open for the search, which then clears, or nil with
  // `searchProblem` saying what a username is.
  public func find() -> Destination? {
    guard let destination = searchDestination else {
      searchProblem = "Enter a username of 3–24 letters, numbers, or underscores."
      return nil
    }
    searchProblem = nil
    username = ""
    return destination
  }

  // The profile the search's username opens, or nil until it is one: 3 to 24
  // letters, numbers, or underscores. Usernames are lowercase.
  public var searchDestination: Destination? {
    let text = username.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (3...24).contains(text.count),
      text.allSatisfy({ $0 == "_" || ($0.isASCII && ($0.isLetter || $0.isNumber)) })
    else { return nil }
    return .profile(username: text.lowercased())
  }
}
