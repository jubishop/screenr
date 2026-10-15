import AuthenticationServices
import Foundation
import Observation

// The sign-in screen: an email code in two steps, Sign in with Apple, and
// Google. A sign-in that succeeds stores the session, which moves
// `SessionStore.phase` to signed in, so the app leaves this screen. Every
// request carries the pending invitation, which a new member needs.
//
// The same model confirms it's the signed-in member again, such as before
// deleting the account: with an email code to the account's own address or a
// sign-in method connected to the account, without the invitation, and only
// for the same member, as `confirming(userId:)` describes.
@MainActor
@Observable
public final class SignInModel {
  // The ways to sign in, in the order the screen offers them.
  public enum Method: Hashable, Sendable {
    case apple
    case google
    case emailCode

    var provider: String {
      switch self {
      case .emailCode: "email"
      case .apple: "Apple"
      case .google: "Google"
      }
    }
  }

  public enum Step: Hashable, Sendable {
    case email
    // A code was requested for this address.
    case code(email: String)
  }

  // The request in flight, if any. Only one runs at a time.
  public enum Activity: Hashable, Sendable {
    case idle
    case sendingCode
    case checkingCode
    case apple
    case google
  }

  public static let codeLength = 6

  public var email = ""
  public private(set) var code = ""
  public private(set) var step = Step.email
  public private(set) var activity = Activity.idle
  // What went wrong with the last attempt, in words for the member.
  public private(set) var failure: String?

  private enum Purpose {
    // Signing in, or joining with the pending invitation.
    case signIn(PendingInvitation)
    // Confirming it's the signed-in member.
    case confirm(MemberConfirmation)
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let purpose: Purpose
  @ObservationIgnored private let providers: IdentityProviders
  @ObservationIgnored private var appleNonce: AppleNonce?
  @ObservationIgnored private var confirmed: @MainActor () -> Void = {}

  public init(api: any ScreenrAPI, invitation: PendingInvitation, providers: IdentityProviders) {
    self.api = api
    purpose = .signIn(invitation)
    self.providers = providers
  }

  // Confirms it's `member` again. A sign-in that succeeds keeps the new
  // session and runs the `onConfirm(_:)` handler.
  public init(
    api: any ScreenrAPI,
    confirming member: MemberConfirmation,
    providers: IdentityProviders
  ) {
    self.api = api
    purpose = .confirm(member)
    self.providers = providers
    email = member.email ?? ""
  }

  // Runs `handler` once a sign-in confirms the member.
  public func onConfirm(_ handler: @escaping @MainActor () -> Void) {
    confirmed = handler
  }

  public var authorization: IdentityProviders.Authorization { providers.authorization }
  // The methods to offer: every one to sign in, and to confirm the member,
  // those their account has.
  public var methods: [Method] {
    switch purpose {
    case .signIn: [.apple, .google, .emailCode]
    case .confirm(let member): member.methods
    }
  }
  // The account's address while confirming the member, which gets the code
  // and cannot change; nil while signing in, when the person types one.
  public var fixedEmail: String? {
    guard case .confirm(let member) = purpose else { return nil }
    return member.email
  }
  // Whether the person opened an invitation link that may still be used.
  public var isInvited: Bool { invitationToken != nil }
  // The web's words for an invitation link the server no longer accepts.
  public var invitationNotice: String? {
    guard case .signIn(let invitation) = purpose, invitation.status == .unavailable else {
      return nil
    }
    return "That invitation is no longer available. Existing members can still sign in."
  }
  public var canSendCode: Bool { activity == .idle && Self.isAddress(trimmedEmail) }
  public var canCheckCode: Bool { activity == .idle && code.count == Self.codeLength }

  // Keeps the digits of what the member typed or pasted, up to six.
  public func enterCode(_ text: String) {
    code = String(text.filter(\.isASCIIDigit).prefix(Self.codeLength))
  }

  public func sendCode() async {
    let address = trimmedEmail
    guard activity == .idle, Self.isAddress(address) else { return }
    begin(.sendingCode)
    defer { activity = .idle }
    do {
      _ = try await api.send(.sendCode(email: address, invitation: invitationToken))
      email = address
      code = ""
      step = .code(email: address)
    } catch {
      failure = message(for: error, method: .emailCode)
    }
  }

  public func checkCode() async {
    guard activity == .idle, case .code(let address) = step, code.count == Self.codeLength
    else { return }
    begin(.checkingCode)
    defer { activity = .idle }
    do {
      _ = try await api.send(
        session(.signIn(email: address, code: code, invitation: invitationToken))
      )
    } catch {
      failure = message(for: error, method: .emailCode)
      return
    }
    succeeded()
  }

  // Back to the address, to change it or request a new code.
  public func useAnotherEmail() {
    guard activity == .idle else { return }
    step = .email
    code = ""
    failure = nil
  }

  // Configures the Sign in with Apple button's request with a new nonce.
  public func prepare(_ request: ASAuthorizationAppleIDRequest) {
    request.requestedScopes = [.fullName, .email]
    request.nonce = startApple()
  }

  // The hashed nonce for a new Sign in with Apple request.
  public func startApple() -> String {
    let nonce = AppleNonce()
    appleNonce = nonce
    failure = nil
    return nonce.hashed
  }

  // The Sign in with Apple button's result.
  public func completeApple(_ result: Result<ASAuthorization, any Error>) async {
    switch result {
    case .success(let authorization):
      guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
        let credential = AppleCredential(
          identityToken: apple.identityToken,
          authorizationCode: apple.authorizationCode,
          fullName: apple.fullName
        )
      else {
        failure = Self.appleUnfinished
        return
      }
      await signInWithApple(credential)
    case .failure(let error):
      failApple(error)
    }
  }

  public func failApple(_ error: any Error) {
    appleNonce = nil
    if let error = error as? ASAuthorizationError, error.code == .canceled { return }
    failure = Self.appleUnfinished
  }

  // Posts Apple's credential with the raw nonce of the request it answers.
  public func signInWithApple(_ credential: AppleCredential) async {
    guard activity == .idle else { return }
    guard let nonce = appleNonce else {
      failure = Self.appleUnfinished
      return
    }
    appleNonce = nil
    begin(.apple)
    defer { activity = .idle }
    do {
      _ = try await api.send(
        session(
          .signInWithApple(
            identityToken: credential.identityToken,
            authorizationCode: credential.authorizationCode,
            nonce: nonce.raw,
            name: credential.name,
            invitation: invitationToken
          )
        )
      )
    } catch {
      failure = message(for: error, method: .apple)
      return
    }
    succeeded()
  }

  // Signs in with the fixture API's stub Apple credential, in place of the
  // system sheet, which UI tests cannot drive.
  public func signInWithFixtureApple() async {
    guard providers.authorization == .fixture else { return }
    let hashed = startApple()
    await signInWithApple(FixtureIdentity.appleCredential(hashedNonce: hashed))
  }

  // Signs in with Google in `system`, the app's web authentication session,
  // or with the fixture API, in its stand-in for Google's page.
  public func signInWithGoogle(using system: any WebAuthenticator) async {
    guard activity == .idle else { return }
    begin(.google)
    defer { activity = .idle }
    let authenticator: any WebAuthenticator =
      switch providers.authorization {
      case .system: system
      case .fixture: FixtureWebAuthenticator()
      }
    let credential: GoogleCredential
    do {
      credential = try await providers.google.signIn(with: authenticator)
    } catch .cancelled {
      return
    } catch .unreachable {
      failure = APIError.explanation(of: .offline)
      return
    } catch {
      failure = "Google sign-in did not finish. Try again."
      return
    }
    do {
      _ = try await api.send(
        session(
          .signInWithGoogle(
            idToken: credential.idToken,
            nonce: credential.nonce,
            invitation: invitationToken
          )
        )
      )
    } catch {
      failure = message(for: error, method: .google)
      return
    }
    succeeded()
  }

  // The invitation each request sends while signing in. Confirming the
  // member never joins, so it sends none.
  private var invitationToken: String? {
    guard case .signIn(let invitation) = purpose else { return nil }
    return invitation.token
  }

  // A sign-in request for this model's purpose.
  private func session(_ request: APIRequest<Acknowledgement>) -> APIRequest<Acknowledgement> {
    guard case .confirm(let member) = purpose else { return request }
    return request.confirming(userId: member.userId)
  }

  private func succeeded() {
    guard case .confirm = purpose else { return }
    confirmed()
  }

  private func begin(_ activity: Activity) {
    self.activity = activity
    failure = nil
  }

  private var trimmedEmail: String {
    fixedEmail ?? email.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func isAddress(_ text: String) -> Bool {
    let parts = text.split(separator: "@", omittingEmptySubsequences: false)
    return parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
      && !text.contains(where: \.isWhitespace)
  }

  private static let appleUnfinished = "Sign in with Apple did not finish. Try again."

  // While confirming the member, an Apple or Google account that belongs to
  // no Screenr account, or is not connected to one, is not this one.
  private func message(for error: APIError, method: Method) -> String? {
    guard case .confirm = purpose, method != .emailCode,
      error.kind == .forbidden || error.code == "OAUTH_LINK_ERROR"
    else { return Self.message(for: error, method: method) }
    return
      "That \(method.provider) account isn’t connected to this Screenr account. Use an email code instead."
  }

  // The server's own words for limits, attempts, and invitations. Better
  // Auth's provider errors get a sentence that says what to do.
  static func message(for error: APIError, method: Method) -> String? {
    switch (error.kind, error.code) {
    case (.cancelled, _):
      return nil
    case (_, "INVALID_TOKEN"):
      return "Screenr could not confirm your \(method.provider) sign-in. Try again."
    case (_, "OAUTH_LINK_ERROR"):
      return
        "That email address already has a Screenr account. Sign in with an email code, then connect \(method.provider) in your account settings."
    case (_, "PROVIDER_NOT_FOUND"):
      return "\(method.provider) sign-in is unavailable right now. Use an email code instead."
    default:
      return error.explanation(otherwise: "Could not sign in. Try again.")
    }
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
