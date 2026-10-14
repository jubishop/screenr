import Foundation
import SwiftUI
import Testing

@testable import ScreenrKit

// The fixture API that UI tests launch the app against.
@MainActor
struct FixtureTransportTests {
  private func services(_ arguments: String...) throws -> AppServices {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
    return try AppServices(
      configuration: configuration,
      arguments: ["Screenr", "-ScreenrFixtures", TestFixtures.directory.path()] + arguments
    )
  }

  @Test func servesTheViewersScreens() async throws {
    let services = try services()

    let feed = try await services.api.send(.screen(path: "/"))
    let title = try await services.api.send(.screen(path: "/titles/tv/201"))

    #expect(services.session.phase == .signedIn)
    #expect(feed.user.username == "alice")
    #expect(feed.feed?.conversations.count == 22)
    guard case .title(let page) = title.content else {
      Issue.record("Expected a title page, not \(title.content)")
      return
    }
    #expect(page.title.name == "Harbor Lights")
  }

  @Test func answersAnUnchangedScreenWith304() async throws {
    let observer = RecordingObserver()
    let session = try SessionStore(keychain: InMemoryKeychain(token: FixtureTransport.token))
    let client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/1",
      session: session,
      transport: try FixtureTransport(directory: TestFixtures.directory),
      observer: observer
    )

    let first = try await client.send(.screen(path: "/"))
    let second = try await client.send(.screen(path: "/"))

    #expect(observer.records.map(\.status) == [200, 304])
    #expect(second == first)
  }

  @Test func prefersTheScenariosViewer() async throws {
    let services = try services("-ScreenrFixtureViewer", "nora")

    let feed = try await services.api.send(.screen(path: "/"))

    #expect(feed.user.username == "nora")
    #expect(feed.feed?.conversations.isEmpty == true)
  }

  @Test func answersWithOverridesFirst() async throws {
    let services = try services(
      "-ScreenrFixtureOverride",
      "screen/feed/empty",
      "-ScreenrFixtureOverride",
      "actions/setup/username-taken"
    )

    let feed = try await services.api.send(.screen(path: "/"))
    let error = await #expect(throws: APIError.self) {
      try await services.api.send(.setup(name: "Pat Morgan", username: "pat"))
    }

    #expect(feed.feed?.conversations.isEmpty == true)
    #expect(error?.kind == .rejected(status: 400))
    #expect(error?.message == "That username is already taken.")
  }

  @Test func fallsBackToTheScreensPathAndToSuccessfulWrites() async throws {
    let services = try services()

    let linked = try await services.api.send(.screen(path: "/titles/movie/101?item=other"))
    let created = try await services.api.send(
      .comment(conversation: "entry", body: "Any text the test types", spoiler: false)
    )
    let setup = try await services.api.send(.setup(name: "Any Name", username: "any"))

    guard case .title(let page) = linked.content else {
      Issue.record("Expected a title page, not \(linked.content)")
      return
    }
    #expect(page.title.id == "movie:101")
    #expect(created.id == "10")
    #expect(setup == Acknowledgement())
  }

  @Test func answersAnUnknownPathWithNotFound() async throws {
    let services = try services()

    let error = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/people/zed"))
    }

    #expect(error?.kind == .notFound)
  }

  @Test func signsInAndOut() async throws {
    let services = try services("-ScreenrFixtureSession", "signedOut")
    #expect(services.session.phase == .signedOut)

    let signedOut = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/"))
    }
    _ = try await services.api.send(.sendCode(email: "alice@example.com"))
    _ = try await services.api.send(.signIn(email: "alice@example.com", code: "123456"))
    #expect(services.session.phase == .signedIn)
    let feed = try await services.api.send(.screen(path: "/"))
    _ = try await services.api.send(.signOut)

    #expect(signedOut?.kind == .signedOut)
    #expect(feed.user.username == "alice")
    #expect(services.session.phase == .signedOut)
  }

  @Test func reportsInvitationsAvailableUnlessOverridden() async throws {
    let services = try services("-ScreenrFixtureSession", "signedOut")
    let unavailable = try self.services(
      "-ScreenrFixtureSession",
      "signedOut",
      "-ScreenrFixtureOverride",
      "auth/invitation/unavailable"
    )

    #expect(try await services.api.send(.invitation(token: "any-link")).available)
    #expect(try await !unavailable.api.send(.invitation(token: "any-link")).available)
  }

  // A new member's account, like the server's, answers only setup, its
  // details, and photo changes until setup succeeds.
  @Test func asksANewMemberToSetUpUntilSetupSucceeds() async throws {
    let services = try services("-ScreenrFixtureViewer", "pat", "-ScreenrFixtureProfile", "pending")

    let beforeSetup = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/"))
    }
    let details = try await services.api.send(.setupDetails)
    let taken = await #expect(throws: APIError.self) {
      try await services.api.send(.setup(name: "Pat Morgan", username: "alice"))
    }
    let stillPending = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/"))
    }
    _ = try await services.api.send(.setup(name: "Pat Morgan", username: "pat", invitation: "link"))
    let feed = try await services.api.send(.screen(path: "/"))
    let profile = try await services.api.send(.screen(path: "/people/pat"))

    #expect(beforeSetup?.kind == .forbidden)
    #expect(beforeSetup?.message == "Complete your profile first.")
    #expect(
      details == SetupDetails(userId: "user-pat", name: "Pat Morgan", photo: nil, google: false)
    )
    #expect(taken?.message == "That username is already taken.")
    #expect(stillPending?.kind == .forbidden)
    // Pat joined through Alice's link, so she is his friend and her entries
    // fill his feed.
    #expect(feed.user.username == "pat")
    #expect(feed.feed?.conversations.isEmpty == false)
    #expect(feed.feed?.conversations.allSatisfy { $0.username == "alice" } == true)
    guard case .profile(let page) = profile.content else {
      Issue.record("Expected Pat's profile, not \(profile.content)")
      return
    }
    #expect(page.profile.friends.map(\.username) == ["alice"])
  }

  @Test func answersSignInWithAnAuthOverride() async throws {
    let services = try services(
      "-ScreenrFixtureSession",
      "signedOut",
      "-ScreenrFixtureOverride",
      "auth/email-otp/send-verification-otp/rate-limited"
    )

    let error = await #expect(throws: APIError.self) {
      try await services.api.send(.sendCode(email: "alice@example.test"))
    }
    _ = try await services.api.send(.signIn(email: "alice@example.test", code: "123456"))

    #expect(error?.kind == .rateLimited)
    #expect(
      error?.message == "Too many codes requested. Try again later, or continue with Google."
    )
    #expect(services.session.phase == .signedIn)
  }

  @Test func signsInWithTheStubAppleAndGoogleCredentials() async throws {
    let services = try services("-ScreenrFixtureSession", "signedOut")
    let model = SignInModel(
      api: services.api,
      invitation: services.invitation,
      providers: services.identity
    )
    #expect(services.identity.authorization == .fixture)

    await model.signInWithFixtureApple()
    #expect(model.failure == nil)
    #expect(services.session.phase == .signedIn)
    _ = try await services.api.send(.signOut)
    // The fixture API stands in for Google's page, so the system session the
    // view passes goes unused.
    await model.signInWithGoogle(using: FailingAuthenticator(error: URLError(.badURL)))

    #expect(model.failure == nil)
    #expect(services.session.phase == .signedIn)
  }

  @Test func rejectsOtherSocialCredentials() async throws {
    let services = try services("-ScreenrFixtureSession", "signedOut")
    let apple = AppleNonce()

    for request in [
      APIRequest.signInWithGoogle(idToken: "fixture-google-token.nonce-1", nonce: "nonce-2"),
      .signInWithApple(
        identityToken: FixtureIdentity.appleCredential(hashedNonce: apple.hashed).identityToken,
        authorizationCode: "fixture-apple-code",
        nonce: "another"
      ),
      .signInWithApple(
        identityToken: FixtureIdentity.appleCredential(hashedNonce: apple.hashed).identityToken,
        authorizationCode: "another",
        nonce: apple.raw
      ),
    ] {
      let error = await #expect(throws: APIError.self) { try await services.api.send(request) }
      #expect(error?.code == "INVALID_TOKEN")
    }
    #expect(services.session.phase == .signedOut)
  }

  @Test func redeemsOnlyTheStubGoogleCodeWithItsVerifier() async throws {
    let google = GoogleSignIn(
      clientID: GoogleSignInTests.clientID,
      transport: try FixtureTransport(directory: TestFixtures.directory)
    )
    let attempt = GoogleSignIn.Attempt()
    let callback = try await FixtureWebAuthenticator()
      .authenticate(
        url: try google.authorizationURL(for: attempt),
        callbackScheme: google.callbackScheme
      )
    let code = try google.code(from: callback, for: attempt)

    let token = try await google.idToken(forCode: code, attempt: attempt)
    await #expect(throws: GoogleSignInError.tokenRejected(status: 400, error: "invalid_grant")) {
      try await google.idToken(forCode: code, attempt: GoogleSignIn.Attempt())
    }

    #expect(token == "fixture-google-token.\(attempt.nonce)")
  }

  @Test func failsEveryRequestWithTheScenariosFailure() async throws {
    let services = try services("-ScreenrFixtureFailure", "errors/incomplete-profile")

    for request in [APIRequest.screen(path: "/"), .screen(path: "/people")] {
      let error = await #expect(throws: APIError.self) { try await services.api.send(request) }
      #expect(error?.kind == .forbidden)
      #expect(error?.message == "Complete your profile first.")
    }
  }

  // UI tests read the log to see when the app polls, which read was its
  // visit, and what it writes.
  @Test func logsEachAPIRequest() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      do {
        try FileManager.default.removeItem(at: directory)
      } catch {
        Issue.record("Could not remove \(directory.path()): \(error)")
      }
    }
    let log = directory.appending(path: "requests.log")
    let services = try services("-ScreenrFixtureLog", log.path())

    _ = try await services.api.send(.screen(path: "/"))
    _ = try await services.api.send(.screen(path: "/titles/tv/201"))
    _ = try await services.api.send(.sendCode(email: "alice@example.com"))
    _ = try await services.api.send(.respondToFriendRequest(notification: "14", .accept))

    // A write's line ends with its JSON body, keys sorted.
    #expect(
      try String(contentsOf: log, encoding: .utf8) == """
        GET /api/screenr/screen?path=%2F visit
        GET /api/screenr/screen?path=%2Ftitles%2Ftv%2F201
        POST /api/screenr/respond-friend-request {"action":"accept","id":"14"}

        """
    )
  }

  // UI tests read what each write sent: a JSON body with sorted keys, or an
  // upload's type and size.
  @Test func logsEachWritesBody() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer {
      do {
        try FileManager.default.removeItem(at: directory)
      } catch {
        Issue.record("Could not remove \(directory.path()): \(error)")
      }
    }
    let log = directory.appending(path: "requests.log")
    let services = try services("-ScreenrFixtureLog", log.path())

    _ = try await services.api.send(.profile(name: "Alice Park", username: "alice/p"))
    _ = try await services.api.send(.uploadPhoto(jpeg: Data([0xFF, 0xD8, 0xFF, 0xE0])))
    _ = try await services.api.send(.removePhoto)

    #expect(
      try String(contentsOf: log, encoding: .utf8) == """
        POST /api/screenr/profile {"name":"Alice Park","username":"alice/p"}
        POST /api/screenr/photo image/jpeg 4 bytes
        POST /api/screenr/remove-photo {}

        """
    )
  }

  @Test func linksOnlyTheStubCredentials() async throws {
    let services = try services()
    let nonce = AppleNonce()

    _ = try await services.api.send(
      .linkApple(
        identityToken: FixtureIdentity.appleCredential(hashedNonce: nonce.hashed).identityToken,
        authorizationCode: "fixture-apple-code",
        nonce: nonce.raw
      )
    )
    let error = await #expect(throws: APIError.self) {
      try await services.api.send(.linkGoogle(idToken: "real-google-token", nonce: "nonce"))
    }

    #expect(error?.kind == .rejected(status: 401))
    #expect(error?.code == "INVALID_TOKEN")
    #expect(services.session.phase == .signedIn)
  }

  @Test func rejectsAMissingFixtureName() {
    #expect(throws: FixtureError.self) {
      try FixtureTransport(
        directory: TestFixtures.directory,
        scenario: FixtureScenario(overrides: ["screen/feed/missing"])
      )
    }
  }
}

struct APISourceTests {
  @Test func usesTheNetworkWithoutFixtures() throws {
    #expect(try APISource(arguments: ["Screenr"], variant: .dev) == .network)
  }

  @Test func readsTheFixtureLaunchArguments() throws {
    let source = try APISource(
      arguments: [
        "Screenr", "-ScreenrFixtures", "/tmp/Fixtures", "-ScreenrFixtureViewer", "nora",
        "-ScreenrFixtureSession", "signedOut", "-ScreenrFixtureOverride", "screen/feed/empty",
        "-ScreenrFixtureOverride", "screen/people/empty", "-ScreenrFixtureFailure",
        "errors/signed-out", "-ScreenrFixtureLog", "/tmp/requests.log", "-AppleLanguages", "(en)",
        "-ScreenrOpenURL", "screenr-dev://people", "-ScreenrFixtureProfile", "pending",
      ],
      variant: .dev
    )

    #expect(
      source
        == .fixtures(
          directory: URL(filePath: "/tmp/Fixtures", directoryHint: .isDirectory),
          scenario: FixtureScenario(
            viewer: "nora",
            session: .signedOut,
            profile: .pending,
            overrides: ["screen/feed/empty", "screen/people/empty"],
            failure: "errors/signed-out",
            requestLog: URL(filePath: "/tmp/requests.log")
          )
        )
    )
  }

  @Test func opensALinkAtLaunchInDev() throws {
    let arguments = ["Screenr", "-ScreenrOpenURL", "screenr-dev://titles/tv/201?item=post"]

    #expect(
      LaunchLink.url(in: arguments, variant: .dev)
        == URL(string: "screenr-dev://titles/tv/201?item=post")
    )
    #expect(LaunchLink.url(in: arguments, variant: .release) == nil)
    #expect(LaunchLink.url(in: ["Screenr", "-ScreenrOpenURL"], variant: .dev) == nil)
    #expect(LaunchLink.url(in: ["Screenr"], variant: .dev) == nil)
  }

  @Test func ignoresFixturesInRelease() throws {
    let arguments = ["Screenr", "-ScreenrFixtures", "/tmp/Fixtures"]
    #expect(try APISource(arguments: arguments, variant: .release) == .network)
  }

  @Test(arguments: [
    ["Screenr", "-ScreenrFixtures"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixtureSession", "maybe"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixtureColor", "red"],
  ])
  func rejectsMalformedArguments(_ arguments: [String]) {
    #expect(throws: APISource.ArgumentError.self) {
      try APISource(arguments: arguments, variant: .dev)
    }
  }
}

// Views read the API from the environment, so a test or a screen's view model
// can run against a fake.
struct EnvironmentTests {
  private struct FakeAPI: ScreenrAPI {
    func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
      throw APIError(kind: .offline, requestID: "fake")
    }
  }

  @Test func replacesTheAPIInTheEnvironment() async {
    var environment = EnvironmentValues()
    environment.screenrAPI = FakeAPI()

    let error = await #expect(throws: APIError.self) {
      try await environment.screenrAPI.send(.screen(path: "/"))
    }
    #expect(error?.requestID == "fake")
  }
}
