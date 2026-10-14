import Foundation
import Observation

// Signing this device out. The server ends the session, and the client then
// removes the token and its screen cache; `SessionStore.onEnd` handlers
// forget the rest, such as cached images. As on the web, a sign-out the
// server never confirmed keeps the session and says so.
@MainActor
@Observable
public final class SignOutModel {
  public enum State: Hashable, Sendable {
    case idle
    case signingOut
    case failed(String)
  }

  public private(set) var state = State.idle
  @ObservationIgnored private let api: any ScreenrAPI

  public init(api: any ScreenrAPI) {
    self.api = api
  }

  public func signOut() async {
    guard state != .signingOut else { return }
    state = .signingOut
    do {
      _ = try await api.send(.signOut)
      state = .idle
    } catch {
      // A session the server already ended is just as signed out; the client
      // removed its token.
      state =
        error.kind == .signedOut
        ? .idle : .failed(error.explanation(otherwise: "Could not sign out. Try again."))
    }
  }

  public func dismissFailure() {
    if case .failed = state { state = .idle }
  }
}
