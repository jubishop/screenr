import Foundation
import Observation

// The invitation link a new member opened, `/join/<token>`, kept until setup
// succeeds, including across launches. Requesting a code, signing in, and
// setup send its token as `Screenr-Invitation`, which a new person needs to
// join. Requesting a code answers the same whether or not the invitation
// counts, so the app asks the server about each link it opens, as the web's
// `/join` route does.
@MainActor
@Observable
public final class PendingInvitation {
  public enum Status: Hashable, Sendable {
    // No invitation link.
    case none
    // Waiting to ask the server about the link, or asking.
    case checking
    // The link can be used to join.
    case available
    // The check failed, such as offline. Requests still send the token, and
    // the server decides.
    case unconfirmed
    // The link is unknown, expired, revoked, or used up, and its token is
    // gone.
    case unavailable
  }

  public private(set) var token: String?
  public private(set) var status: Status
  @ObservationIgnored private let storage: any KeychainStorage

  // A link already checked, kept only in memory, as tests and the fixture API
  // use.
  public init(token: String? = nil) {
    self.token = token
    status = token == nil ? .none : .available
    storage = InMemoryKeychain(token: token)
  }

  // The link an earlier launch kept, which the app checks again.
  public init(storage: any KeychainStorage) {
    self.storage = storage
    var kept: String?
    do {
      kept = try storage.read()
    } catch {
      Log.session.error("Could not read the pending invitation", .int("status", Int(error.status)))
    }
    token = kept
    status = kept == nil ? .none : .checking
  }

  // Keeps an opened link's token, in place of any other, until it is checked.
  public func open(_ token: String) {
    self.token = token
    status = .checking
    do {
      try storage.write(token)
    } catch {
      Log.session.error("Could not keep the pending invitation", .int("status", Int(error.status)))
    }
  }

  // Asks the server whether a link waiting for a check can still be used,
  // and forgets one that cannot.
  public func check(using api: any ScreenrAPI) async {
    guard status == .checking, let token else { return }
    let result: Status
    do throws(APIError) {
      result = try await api.send(.invitation(token: token)).available ? .available : .unavailable
    } catch {
      if error.kind == .cancelled { return }
      result = .unconfirmed
    }
    // Another link replaced this one while the server answered.
    guard self.token == token, status == .checking else { return }
    if result == .unavailable { forget() }
    status = result
  }

  // Asks again after the server refused the invitation, such as at setup.
  public func recheck(using api: any ScreenrAPI) async {
    guard token != nil else { return }
    status = .checking
    await check(using: api)
  }

  // Forgets the invitation once it is no longer needed: setup used it, or a
  // member who already has a profile followed the link.
  public func finish() {
    forget()
    status = .none
  }

  private func forget() {
    token = nil
    do {
      try storage.delete()
    } catch {
      Log.session.error(
        "Could not forget the pending invitation",
        .int("status", Int(error.status))
      )
    }
  }
}

// How the app authorizes with Apple and Google before it posts their tokens
// to the server.
public struct IdentityProviders: Sendable {
  public enum Authorization: Hashable, Sendable {
    // The system's Sign in with Apple sheet, and Google in a web
    // authentication session.
    case system
    // Screenr Dev against the fixture API: stub credentials stand in for
    // Apple's sheet and Google's page, and the fixture API accepts only them.
    case fixture
  }

  public let authorization: Authorization
  public let google: GoogleSignIn

  public init(authorization: Authorization, google: GoogleSignIn) {
    self.authorization = authorization
    self.google = google
  }
}
