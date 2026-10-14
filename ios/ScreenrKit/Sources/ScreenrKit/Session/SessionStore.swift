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

  public private(set) var phase: Phase
  @ObservationIgnored private let keychain: any KeychainStorage
  @ObservationIgnored private(set) var token: String?

  public init(keychain: any KeychainStorage) throws(KeychainError) {
    self.keychain = keychain
    let token = try keychain.read()
    self.token = token
    phase = token == nil ? .signedOut : .signedIn
  }

  func signIn(token: String) throws(KeychainError) {
    try keychain.write(token)
    self.token = token
    if case .updateRequired = phase { return }
    phase = .signedIn
  }

  // Ends the session that `token` belonged to. A request that started before
  // a newer sign-in must not remove the newer token, and the app may have
  // stored one while another process, such as the notification extension,
  // still held the old one. So this checks the Keychain before removing it.
  func end(token ended: String) throws(KeychainError) {
    if token == ended { token = nil }
    if token == nil, case .signedIn = phase { phase = .signedOut }
    guard try keychain.read() == ended else { return }
    try keychain.delete()
  }

  func requireUpdate(minimumBuild: Int?) {
    phase = .updateRequired(minimumBuild: minimumBuild)
  }
}
