import Foundation
import Observation

// The device's session: the bearer token, kept in the Keychain, and the phase
// the app shell shows. The client stores the token after a sign-in, removes it
// on sign-out or when the server says the session is gone, and requires an
// update when the server answers 426.
@MainActor
@Observable
public final class SessionStore {
  public enum Phase: Hashable, Sendable {
    case signedOut
    case signedIn
    // The server no longer accepts this build. It stays until the app is updated.
    case updateRequired(minimumBuild: Int?)
  }

  // How a session ended.
  public enum Ending: Hashable, Sendable {
    // The member signed out.
    case signedOut
    // The server no longer accepts the session, such as after it expired,
    // so the member did not choose to leave.
    case expired
    // The member deleted their account.
    case accountDeleted
  }

  public private(set) var phase: Phase
  // How the last session ended, until the next sign-in, so the sign-in
  // screen can say the account was deleted. Nil after a launch.
  public private(set) var ending: Ending?
  @ObservationIgnored private let keychain: any KeychainStorage
  @ObservationIgnored private(set) var token: String?
  @ObservationIgnored private var endHandlers: [@MainActor (Ending) -> Void] = []

  public init(keychain: any KeychainStorage) throws(KeychainError) {
    self.keychain = keychain
    let token = try keychain.read()
    self.token = token
    phase = token == nil ? .signedOut : .signedIn
  }

  func signIn(token: String) throws(KeychainError) {
    try keychain.write(token)
    self.token = token
    ending = nil
    if case .updateRequired = phase { return }
    phase = .signedIn
  }

  // Runs `handler` with how the session ended each time it ends, whether the
  // member signed out, the server ended the session, or the member deleted
  // their account, so the app forgets what the member saw, such as cached
  // images and the error-reporting user.
  public func onEnd(_ handler: @escaping @MainActor (Ending) -> Void) {
    endHandlers.append(handler)
  }

  // Ends the session that `token` belonged to. A request that started before
  // a newer sign-in must not remove the newer token, and the app may have
  // stored one while another process, such as the notification extension,
  // still held the old one. So this checks the Keychain before removing it.
  func end(token ended: String, ending: Ending = .signedOut) throws(KeychainError) {
    let current = token == ended
    if current {
      token = nil
      self.ending = ending
    }
    if token == nil, case .signedIn = phase { phase = .signedOut }
    if current {
      for handler in endHandlers { handler(ending) }
    }
    guard try keychain.read() == ended else { return }
    try keychain.delete()
  }

  func requireUpdate(minimumBuild: Int?) {
    phase = .updateRequired(minimumBuild: minimumBuild)
  }
}
