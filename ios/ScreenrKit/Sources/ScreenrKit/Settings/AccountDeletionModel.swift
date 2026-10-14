import Foundation
import Observation

// The signed-in member that a sign-in must confirm: their user ID, the
// address that gets their sign-in codes, and the sign-in methods their
// account has.
public struct MemberConfirmation: Hashable, Sendable {
  public let userId: String
  public let email: String?
  public let methods: [SignInModel.Method]

  public init(userId: String, email: String?, methods: [SignInModel.Method]) {
    self.userId = userId
    self.email = email
    self.methods = methods
  }

  // From Settings: email codes go to the account's address, and Apple and
  // Google count only when they are connected to the account.
  public init(account: AccountScreen, viewer: Person) {
    var methods: [SignInModel.Method] = []
    if account.appleEnabled == true, account.appleConnected == true { methods.append(.apple) }
    if account.googleEnabled, account.googleConnected { methods.append(.google) }
    if account.email != nil { methods.append(.emailCode) }
    self.init(userId: viewer.userId, email: account.email, methods: methods)
  }
}

// Deleting the account from Settings, as the web's Account page does. The
// server deletes only from a sign-in in the last ten minutes, so the member
// first confirms it's them with a new sign-in, by any method their account
// has, and then confirms the deletion. Deleting ends the session, so the app
// returns to sign-in, which says the account was deleted.
@MainActor
@Observable
public final class AccountDeletionModel {
  public enum Step: Hashable, Sendable {
    // Signing in again.
    case verify
    // Signed in again; the member confirms the deletion.
    case confirm
    case deleting
    // The account is gone, and so is the session.
    case deleted
  }

  public private(set) var step = Step.verify
  // Why the last deletion did not happen, such as a sign-in that is too old
  // or Sign in with Apple that could not be disconnected.
  public private(set) var failure: String?
  // Confirms it's the member, with the sign-in screen's methods.
  public let signIn: SignInModel

  @ObservationIgnored private let api: any ScreenrAPI

  public init(api: any ScreenrAPI, member: MemberConfirmation, providers: IdentityProviders) {
    self.api = api
    signIn = SignInModel(api: api, confirming: member, providers: providers)
    signIn.onConfirm { [weak self] in self?.confirmed() }
  }

  public func delete() async {
    guard step == .confirm else { return }
    step = .deleting
    failure = nil
    do {
      _ = try await api.send(.deleteAccount)
      step = .deleted
    } catch {
      switch error.kind {
      case .cancelled:
        step = .confirm
      // The new sign-in is more than ten minutes old: sign in again.
      case .forbidden:
        signIn.useAnotherEmail()
        step = .verify
        failure = error.explanation(otherwise: Self.staleSignIn)
      // Nothing was deleted, so the member can try again, such as when
      // Sign in with Apple could not be disconnected.
      default:
        step = .confirm
        failure = error.explanation(otherwise: "Could not delete your account. Try again.")
      }
    }
  }

  private func confirmed() {
    guard step == .verify else { return }
    failure = nil
    step = .confirm
  }

  private static let staleSignIn =
    "To delete your account, confirm it’s you again with a new sign-in."
}
