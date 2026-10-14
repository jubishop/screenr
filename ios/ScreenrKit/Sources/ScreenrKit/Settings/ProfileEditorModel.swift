import Foundation
import Observation

// Editing the display name and username together, as the web's Account page
// does. Both save at once, and a rejected change leaves both as they were.
// The fields follow signup's rules: a display name of 1 to 60 characters, and
// a username of 3 to 24 letters, numbers, or underscores, which the server
// saves in lowercase.
@MainActor
@Observable
public final class ProfileEditorModel {
  public enum State: Hashable, Sendable {
    case editing
    case saving
    case saved
  }

  public static let usernameHelp =
    "Use 3–24 letters, numbers, or underscores. Usernames are saved in lowercase. Changing your username changes your profile link. Old links will no longer lead to your profile. Someone else can use your old username."

  public var name: String
  public var username: String
  public private(set) var state = State.editing
  // The server's reason for rejecting the change, such as a taken username.
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let onSave: @MainActor (Person) async -> Void

  // Starts with the person's current names. `onSave` gets the saved profile.
  public init(
    person: Person,
    api: any ScreenrAPI,
    onSave: @escaping @MainActor (Person) async -> Void
  ) {
    name = person.displayName
    username = person.username
    self.api = api
    self.onSave = onSave
  }

  public var canSave: Bool {
    state == .editing && Self.isValid(name: name, username: username)
  }

  public func save() async {
    guard canSave else { return }
    state = .saving
    failure = nil
    do {
      let person = try await api.send(.profile(name: name, username: username))
      await onSave(person)
      state = .saved
    } catch {
      state = .editing
      if error.kind != .cancelled {
        failure = error.explanation(otherwise: "Your profile could not be saved. Try again.")
      }
    }
  }

  // The web counts characters as JavaScript does, in UTF-16 code units.
  static func isValid(name: String, username: String) -> Bool {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
    return (1...60).contains(trimmedName.utf16.count)
      && trimmedUsername.wholeMatch(of: /[A-Za-z0-9_]{3,24}/) != nil
  }
}
