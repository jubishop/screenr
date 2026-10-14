import AuthenticationServices
import Foundation
import Observation

// The sign-in screen: an email code in two steps, Sign in with Apple, and
// Google. A sign-in that succeeds stores the session, which moves
// `SessionStore.phase` to signed in, so the app leaves this screen. Every
// request carries the pending invitation, which a new member needs.
@MainActor
@Observable
public final class SignInModel {
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

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let invitation: PendingInvitation
  @ObservationIgnored private let providers: IdentityProviders
  @ObservationIgnored private var appleNonce: AppleNonce?

  public init(api: any ScreenrAPI, invitation: PendingInvitation, providers: IdentityProviders) {
    self.api = api
    self.invitation = invitation
    self.providers = providers
  }

  public var authorization: IdentityProviders.Authorization { providers.authorization }
  // Whether the person opened an invitation link that may still be used.
  public var isInvited: Bool { invitation.token != nil }
  // The web's words for an invitation link the server no longer accepts.
  public var invitationNotice: String? {
    invitation.status == .unavailable
      ? "That invitation is no longer available. Existing members can still sign in." : nil
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
      _ = try await api.send(.sendCode(email: address, invitation: invitation.token))
      email = address
      code = ""
      step = .code(email: address)
    } catch {
      failure = Self.message(for: error, method: .emailCode)
    }
  }

  public func checkCode() async {
    guard activity == .idle, case .code(let address) = step, code.count == Self.codeLength
    else { return }
    begin(.checkingCode)
    defer { activity = .idle }
    do {
      _ = try await api.send(.signIn(email: address, code: code, invitation: invitation.token))
    } catch {
      failure = Self.message(for: error, method: .emailCode)
    }
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
        .signInWithApple(
          identityToken: credential.identityToken,
          authorizationCode: credential.authorizationCode,
          nonce: nonce.raw,
          name: credential.name,
          invitation: invitation.token
        )
      )
    } catch {
      failure = Self.message(for: error, method: .apple)
    }
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
        .signInWithGoogle(
          idToken: credential.idToken,
          nonce: credential.nonce,
          invitation: invitation.token
        )
      )
    } catch {
      failure = Self.message(for: error, method: .google)
    }
  }

  private func begin(_ activity: Activity) {
    self.activity = activity
    failure = nil
  }

  private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

  private static func isAddress(_ text: String) -> Bool {
    let parts = text.split(separator: "@", omittingEmptySubsequences: false)
    return parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
      && !text.contains(where: \.isWhitespace)
  }

  private static let appleUnfinished = "Sign in with Apple did not finish. Try again."

  enum Method {
    case emailCode
    case apple
    case google

    var provider: String {
      switch self {
      case .emailCode: "email"
      case .apple: "Apple"
      case .google: "Google"
      }
    }
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
