import AuthenticationServices
import Foundation
import Observation

// Adding Google or Sign in with Apple as another way into the signed-in
// account. A matching email address never links accounts on its own, so a
// member links a provider from here, with the same credential a sign-in
// posts. The provider's verified address must match the account's.
@MainActor
@Observable
public final class AccountLinkModel {
  public enum Provider: Hashable, Sendable {
    case apple
    case google

    public var name: String {
      switch self {
      case .apple: "Apple"
      case .google: "Google"
      }
    }
  }

  public enum State: Hashable, Sendable {
    case idle
    case linking(Provider)
  }

  public private(set) var state = State.idle
  // The provider the last link connected, for the status line.
  public private(set) var linked: Provider?
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let providers: IdentityProviders
  @ObservationIgnored private let onLink: @MainActor () async -> Void
  @ObservationIgnored private var appleNonce: AppleNonce?

  // `onLink` reads the screen again, which then shows the provider connected.
  public init(
    api: any ScreenrAPI,
    providers: IdentityProviders,
    onLink: @escaping @MainActor () async -> Void
  ) {
    self.api = api
    self.providers = providers
    self.onLink = onLink
  }

  public var authorization: IdentityProviders.Authorization { providers.authorization }

  // Configures the Sign in with Apple button's request. The server needs the
  // Apple ID's email address to match the account's.
  public func prepare(_ request: ASAuthorizationAppleIDRequest) {
    request.requestedScopes = [.email]
    request.nonce = startApple()
  }

  // The hashed nonce for a new Sign in with Apple request.
  public func startApple() -> String {
    let nonce = AppleNonce()
    appleNonce = nonce
    failure = nil
    linked = nil
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
          fullName: nil
        )
      else {
        failure = Self.appleUnfinished
        return
      }
      await linkApple(credential)
    case .failure(let error):
      appleNonce = nil
      if let error = error as? ASAuthorizationError, error.code == .canceled { return }
      failure = Self.appleUnfinished
    }
  }

  // Posts Apple's credential with the raw nonce of the request it answers.
  public func linkApple(_ credential: AppleCredential) async {
    guard state == .idle else { return }
    guard let nonce = appleNonce else {
      failure = Self.appleUnfinished
      return
    }
    appleNonce = nil
    await link(.apple) { api throws(APIError) in
      try await api.send(
        .linkApple(
          identityToken: credential.identityToken,
          authorizationCode: credential.authorizationCode,
          nonce: nonce.raw
        )
      )
    }
  }

  // Links the fixture API's stub Apple credential, in place of the system
  // sheet, which UI tests cannot drive.
  public func linkFixtureApple() async {
    guard providers.authorization == .fixture else { return }
    let hashed = startApple()
    await linkApple(FixtureIdentity.appleCredential(hashedNonce: hashed))
  }

  // Runs Google's sign-in in `system`, the app's web authentication session,
  // or under the fixture API in its stand-in, then links the account.
  public func linkGoogle(using system: any WebAuthenticator) async {
    guard state == .idle else { return }
    state = .linking(.google)
    failure = nil
    linked = nil
    let authenticator: any WebAuthenticator =
      switch providers.authorization {
      case .system: system
      case .fixture: FixtureWebAuthenticator()
      }
    let credential: GoogleCredential
    do {
      credential = try await providers.google.signIn(with: authenticator)
    } catch {
      state = .idle
      switch error {
      case .cancelled: break
      case .unreachable: failure = APIError.explanation(of: .offline)
      default: failure = "Google sign-in did not finish. Try again."
      }
      return
    }
    await link(.google) { api throws(APIError) in
      try await api.send(.linkGoogle(idToken: credential.idToken, nonce: credential.nonce))
    }
  }

  private func link(
    _ provider: Provider,
    _ send: @MainActor (any ScreenrAPI) async throws(APIError) -> Acknowledgement
  ) async {
    state = .linking(provider)
    failure = nil
    linked = nil
    defer { state = .idle }
    do {
      _ = try await send(api)
    } catch {
      failure = Self.message(for: error, provider: provider)
      return
    }
    await onLink()
    linked = provider
  }

  private static let appleUnfinished = "Sign in with Apple did not finish. Try again."

  // Better Auth's linking errors carry codes, not sentences for members.
  static func message(for error: APIError, provider: Provider) -> String? {
    let name = provider.name
    switch (error.kind, error.code) {
    case (.cancelled, _):
      return nil
    case (_, "INVALID_TOKEN"), (_, "LINKING_FAILED"):
      return "Screenr could not confirm your \(name) account. Try again."
    case (_, "LINKING_DIFFERENT_EMAILS_NOT_ALLOWED"), (_, "USER_EMAIL_NOT_FOUND"):
      switch provider {
      case .google:
        return "Choose the Google account with the same email address as your Screenr account."
      case .apple:
        return
          "Use the Apple ID with the same email address as your Screenr account, and share your email instead of hiding it."
      }
    case (_, "LINKING_NOT_ALLOWED"):
      return "Verify your \(name) account's email address, then try again."
    case (_, "SOCIAL_ACCOUNT_ALREADY_LINKED"):
      return "That \(name) account already signs in to another Screenr account."
    case (_, "PROVIDER_NOT_FOUND"):
      return "Connecting \(name) is unavailable right now. Try again later."
    default:
      return error.explanation(otherwise: "\(name) could not be connected. Please try again.")
    }
  }
}
