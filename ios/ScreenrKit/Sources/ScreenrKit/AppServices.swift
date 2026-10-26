import Foundation
import SwiftUI

// The protocol-typed clients the app's views use, which tests replace with
// fakes. The app builds them once and injects them with `.screenrServices(_:)`;
// views read `@Environment(\.screenrAPI)`, `@Environment(SessionStore.self)`,
// `@Environment(PendingInvitation.self)`, `@Environment(\.identityProviders)`,
// `@Environment(\.visitTracker)`, `@Environment(\.imageSource)`,
// `@Environment(\.photoLibrary)`, `@Environment(\.feedbackService)`, and
// `@Environment(\.trailerLoading)`.
public struct AppServices: Sendable {
  // The process the services run in: the app, or one of its extensions.
  public enum Host: Hashable, Sendable {
    case app
    case shareExtension
    case notificationExtension
  }

  public let api: any ScreenrAPI
  public let session: SessionStore
  public let invitation: PendingInvitation
  public let identity: IdentityProviders
  public let photoLibrary: PhotoLibrary
  // Posters and profile photos load through `imageSession`, which keeps them
  // in `imageCache`. The cache empties when the session ends.
  public let imageCache: URLCache
  public let imageSession: URLSession
  // The app reports its scene phase here, for the visits the client marks.
  public let visits: VisitTracker
  // The poster and profile photo requests for `AsyncImage`.
  public let images: ImageSource
  // Where the Send feedback form sends, and the log it attaches.
  public let feedback: FeedbackService
  // Where trailers' players load from.
  public let trailers: TrailerLoading
  // iOS's notification permission, APNs registration, and badge, or nil in
  // the extensions, which leave them to the app.
  public let push: (any PushSystem)?

  @MainActor
  public init(
    api: any ScreenrAPI,
    session: SessionStore,
    invitation: PendingInvitation = PendingInvitation(),
    identity: IdentityProviders,
    photoLibrary: PhotoLibrary = .system,
    imageCache: URLCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 0),
    visits: VisitTracker = VisitTracker(),
    images: ImageSource = .none,
    feedback: FeedbackService = .none,
    trailers: TrailerLoading = .network,
    push: (any PushSystem)? = nil
  ) {
    self.api = api
    self.session = session
    self.invitation = invitation
    self.identity = identity
    self.photoLibrary = photoLibrary
    self.imageCache = imageCache
    self.visits = visits
    self.images = images
    self.feedback = feedback
    self.trailers = trailers
    self.push = push
    imageSession = URLSession(configuration: Self.imageConfiguration(cache: imageCache))
    session.onEnd { _ in imageCache.removeAllCachedResponses() }
    // A deleted account leaves nothing in the Keychain. The client removed
    // the session token, and an invitation link kept for joining goes too.
    session.onEnd { ending in
      if ending == .accountDeleted { invitation.finish() }
    }
  }

  // The live client and Keychain session and invitation, or in Screenr Dev,
  // the fixture API when the launch arguments name a fixtures directory. The
  // fixture API also stands in for Apple's and Google's authorization and
  // iOS's push permission, keeps the invitation in memory, and writes
  // feedback to its request log rather than to `feedback`, the build's
  // sender, which Screenr Dev lacks. Only the app's client marks visits; the
  // extensions' send none. `push` is iOS's own push system, which the app
  // target provides; the extensions have none.
  @MainActor
  public init(
    configuration: AppConfiguration,
    arguments: [String],
    observer: (any APIRequestObserver)? = nil,
    feedback: (any FeedbackSender)? = nil,
    logFile: LogFile? = nil,
    host: Host = .app,
    push system: (any PushSystem)? = nil
  ) throws {
    let source = try APISource(arguments: arguments, variant: configuration.variant)
    let keychain: any KeychainStorage
    let invitation: PendingInvitation
    let transport: any HTTPTransport
    let authorization: IdentityProviders.Authorization
    let photoLibrary: PhotoLibrary
    let imageCache: URLCache
    let feedbackSender: (any FeedbackSender)?
    let trailers: TrailerLoading
    let push: (any PushSystem)?
    switch source {
    case .network:
      push = system
      keychain = SystemKeychain(accessGroup: configuration.appGroup)
      invitation = PendingInvitation(
        storage: SystemKeychain.invitation(accessGroup: configuration.appGroup)
      )
      transport = URLSessionTransport()
      authorization = .system
      photoLibrary = .system
      imageCache = URLCache(
        memoryCapacity: 32 << 20,
        diskCapacity: 256 << 20,
        directory: URL.cachesDirectory.appending(path: "Images", directoryHint: .isDirectory)
      )
      feedbackSender = feedback
      trailers = .network
    case .fixtures(let directory, let scenario):
      let token: String? =
        switch scenario.session {
        case .signedIn: FixtureTransport.token
        case .signedOut: nil
        case .expired: FixtureTransport.expiredToken
        }
      keychain = InMemoryKeychain(token: token)
      invitation = PendingInvitation()
      let fixtures = try FixtureTransport(directory: directory, scenario: scenario)
      transport = fixtures
      feedbackSender = fixtures.feedback
      authorization = .fixture
      photoLibrary = .fixture
      imageCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 0)
      // Trailers load nothing; the request log shows what they asked for.
      trailers = .recording(fixtures.recordWebLoad)
      if system != nil, let permission = scenario.push.permission {
        push = FixturePushSystem(permission: permission)
      } else {
        push = system
      }
    }
    let session = try SessionStore(keychain: keychain)
    let visits = VisitTracker()
    let images: ImageSource =
      switch source {
      case .network:
        ImageSource(
          serverURL: configuration.serverURL,
          clientHeader: configuration.clientHeader,
          session: session
        )
      // The fixture API serves no images, so tests never reach the network.
      case .fixtures: .none
      }
    self.init(
      api: ScreenrClient(
        serverURL: configuration.serverURL,
        clientHeader: configuration.clientHeader,
        session: session,
        transport: transport,
        observer: observer,
        visits: host == .app ? visits : nil
      ),
      session: session,
      invitation: invitation,
      identity: IdentityProviders(
        authorization: authorization,
        google: GoogleSignIn(clientID: configuration.googleClientID, transport: transport)
      ),
      photoLibrary: photoLibrary,
      imageCache: imageCache,
      visits: visits,
      images: images,
      feedback: FeedbackService(sender: feedbackSender, logFile: logFile),
      trailers: trailers,
      push: push
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
//   -ScreenrFixtureSession signedIn|signedOut|expired (default signedIn)
//   -ScreenrFixtureProfile complete|pending   (default complete)
//   -ScreenrFixtureOverride <fixture name>    (repeatable)
//   -ScreenrFixtureFailure <fixture name>
//   -ScreenrFixtureLog <file for a line per API request>
//   -ScreenrFixturePush undecided|allowed|denied|system (default undecided)
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
      case "-ScreenrFixtureLog": scenario.requestLog = URL(filePath: value)
      case "-ScreenrFixturePush":
        guard let push = FixtureScenario.Push(rawValue: value) else {
          throw ArgumentError(
            description: "\(argument) is undecided, allowed, denied, or system, not \(value)"
          )
        }
        scenario.push = push
      case "-ScreenrFixtureSession":
        guard let session = FixtureScenario.Session(rawValue: value) else {
          throw ArgumentError(
            description: "\(argument) is signedIn, signedOut, or expired, not \(value)"
          )
        }
        scenario.session = session
      case "-ScreenrFixtureProfile":
        guard let profile = FixtureScenario.Profile(rawValue: value) else {
          throw ArgumentError(description: "\(argument) is complete or pending, not \(value)")
        }
        scenario.profile = profile
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
  // Nil outside `.screenrServices(_:)`.
  @Entry public var visitTracker: VisitTracker?
  @Entry public var imageSource = ImageSource.none
  @Entry public var photoLibrary: PhotoLibrary = .system
  @Entry public var feedbackService = FeedbackService.none
  @Entry public var trailerLoading = TrailerLoading.network
}

extension View {
  public func screenrServices(_ services: AppServices) -> some View {
    environment(\.screenrAPI, services.api)
      .environment(services.session)
      .environment(services.invitation)
      .environment(\.identityProviders, services.identity)
      .environment(\.visitTracker, services.visits)
      .environment(\.imageSource, services.images)
      .environment(\.photoLibrary, services.photoLibrary)
      .environment(\.feedbackService, services.feedback)
      .environment(\.trailerLoading, services.trailers)
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
