import Foundation
import SwiftUI

// The protocol-typed clients the app's views use, which tests replace with
// fakes. The app builds them once and injects them with `.screenrServices(_:)`;
// views read `@Environment(\.screenrAPI)`, `@Environment(SessionStore.self)`,
// `@Environment(PendingInvitation.self)`, and `@Environment(\.identityProviders)`.
public struct AppServices: Sendable {
  public let api: any ScreenrAPI
  public let session: SessionStore
  public let invitation: PendingInvitation
  public let identity: IdentityProviders
  // Posters and profile photos load through `imageSession`, which keeps them
  // in `imageCache`. The cache empties when the session ends.
  public let imageCache: URLCache
  public let imageSession: URLSession

  @MainActor
  public init(
    api: any ScreenrAPI,
    session: SessionStore,
    invitation: PendingInvitation = PendingInvitation(),
    identity: IdentityProviders,
    imageCache: URLCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 0)
  ) {
    self.api = api
    self.session = session
    self.invitation = invitation
    self.identity = identity
    self.imageCache = imageCache
    imageSession = URLSession(configuration: Self.imageConfiguration(cache: imageCache))
    session.onEnd { imageCache.removeAllCachedResponses() }
  }

  // The live client and Keychain session, or in Screenr Dev, the fixture API
  // when the launch arguments name a fixtures directory. The fixture API also
  // stands in for Apple's and Google's authorization.
  @MainActor
  public init(
    configuration: AppConfiguration,
    arguments: [String],
    observer: (any APIRequestObserver)? = nil
  ) throws {
    let source = try APISource(arguments: arguments, variant: configuration.variant)
    let keychain: any KeychainStorage
    let transport: any HTTPTransport
    let authorization: IdentityProviders.Authorization
    let imageCache: URLCache
    switch source {
    case .network:
      keychain = SystemKeychain(accessGroup: configuration.appGroup)
      transport = URLSessionTransport()
      authorization = .system
      imageCache = URLCache(
        memoryCapacity: 32 << 20,
        diskCapacity: 256 << 20,
        directory: URL.cachesDirectory.appending(path: "Images", directoryHint: .isDirectory)
      )
    case .fixtures(let directory, let scenario):
      let token = scenario.session == .signedIn ? FixtureTransport.token : nil
      keychain = InMemoryKeychain(token: token)
      transport = try FixtureTransport(directory: directory, scenario: scenario)
      authorization = .fixture
      imageCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 0)
    }
    let session = try SessionStore(keychain: keychain)
    self.init(
      api: ScreenrClient(
        serverURL: configuration.serverURL,
        clientHeader: configuration.clientHeader,
        session: session,
        transport: transport,
        observer: observer
      ),
      session: session,
      identity: IdentityProviders(
        authorization: authorization,
        google: GoogleSignIn(clientID: configuration.googleClientID, transport: transport)
      ),
      imageCache: imageCache
    )
  }

  // Images send no cookies, and their responses' caching headers apply.
  static func imageConfiguration(cache: URLCache) -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.default
    configuration.urlCache = cache
    configuration.requestCachePolicy = .useProtocolCachePolicy
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    return configuration
  }
}

// Where the app's requests go. UI tests launch Screenr Dev against the
// checked-in fixtures with these launch arguments:
//
//   -ScreenrFixtures <path to ios/ScreenrKit/Fixtures>
//   -ScreenrFixtureViewer <username>          (default alice)
//   -ScreenrFixtureSession signedIn|signedOut (default signedIn)
//   -ScreenrFixtureOverride <fixture name>    (repeatable)
//   -ScreenrFixtureFailure <fixture name>
//
// Release builds ignore them.
public enum APISource: Hashable, Sendable {
  case network
  case fixtures(directory: URL, scenario: FixtureScenario)

  public struct ArgumentError: Error, Hashable, Sendable, CustomStringConvertible {
    public let description: String
  }

  public init(arguments: [String], variant: AppConfiguration.Variant) throws(ArgumentError) {
    var directory: URL?
    var scenario = FixtureScenario()
    var remaining = arguments.dropFirst()[...]
    while let argument = remaining.popFirst() {
      guard argument.hasPrefix("-ScreenrFixture") else { continue }
      guard let value = remaining.popFirst() else {
        throw ArgumentError(description: "\(argument) needs a value")
      }
      switch argument {
      case "-ScreenrFixtures": directory = URL(filePath: value, directoryHint: .isDirectory)
      case "-ScreenrFixtureViewer": scenario.viewer = value
      case "-ScreenrFixtureOverride": scenario.overrides.append(value)
      case "-ScreenrFixtureFailure": scenario.failure = value
      case "-ScreenrFixtureSession":
        guard let session = FixtureScenario.Session(rawValue: value) else {
          throw ArgumentError(description: "\(argument) is signedIn or signedOut, not \(value)")
        }
        scenario.session = session
      default:
        throw ArgumentError(description: "Unknown launch argument \(argument)")
      }
    }
    guard variant == .dev, let directory else {
      self = .network
      return
    }
    self = .fixtures(directory: directory, scenario: scenario)
  }
}

extension EnvironmentValues {
  @Entry public var screenrAPI: any ScreenrAPI = MissingAPI()
  // Nil outside `.screenrServices(_:)`.
  @Entry public var identityProviders: IdentityProviders?
}

extension View {
  public func screenrServices(_ services: AppServices) -> some View {
    environment(\.screenrAPI, services.api)
      .environment(services.session)
      .environment(services.invitation)
      .environment(\.identityProviders, services.identity)
      .asyncImageURLSession(services.imageSession)
  }
}

// The environment's default, so a view outside `.screenrServices(_:)` fails
// loudly instead of reaching no server.
private struct MissingAPI: ScreenrAPI {
  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    preconditionFailure("Inject the API with .screenrServices(_:) before sending \(request.route)")
  }
}
