import Foundation
import SwiftUI
import Testing

@testable import ScreenrKit

// The fixture API that UI tests launch the app against.
@MainActor
struct FixtureTransportTests {
  // The services a Screenr Dev launch builds in the app, or in an extension,
  // which has no push system.
  private func services(
    _ arguments: String...,
    host: AppServices.Host = .app
  ) throws -> AppServices {
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
      arguments: ["Screenr", "-ScreenrFixtures", TestFixtures.directory.path()] + arguments,
      host: host,
      push: host == .app ? RecordingPushSystem(.undecided) : nil
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

  // A UI test brings new activity at a moment it chooses: once the signal
  // file exists, the update answers before the scenario's other fixtures.
  @Test func answersWithUpdatesOnceTheirSignalExists() async throws {
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
    let signal = directory.appending(path: "update")
    let services = try services(
      "-ScreenrFixtureOverride",
      "screen/feed/empty",
      "-ScreenrFixtureUpdate",
      "screen/feed/incoming",
      "-ScreenrFixtureUpdateSignal",
      signal.path()
    )

    let before = try await services.api.send(.screen(path: "/"))
    #expect(FileManager.default.createFile(atPath: signal.path(), contents: Data()))
    let after = try await services.api.send(.screen(path: "/"))
    let people = try await services.api.send(.screen(path: "/people"))

    #expect(before.feed?.conversations.isEmpty == true)
    #expect(after.feed?.conversations.count == 23)
    #expect(
      after.feed?.conversations.first?.body
        == "Who wants to rewatch the Harbor Lights finale on Sunday?"
    )
    #expect(people.user.username == "alice")
  }

  // A UI test fails reads at a moment it chooses: while the outage signal
  // file exists, every request gets a 502 without a body, as from the proxy
  // during a deploy, and removing the file ends the outage.
  @Test func failsEveryRequestWhileTheOutageSignalExists() async throws {
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
    let signal = directory.appending(path: "outage")
    let services = try services("-ScreenrFixtureOutageSignal", signal.path())

    let before = try await services.api.send(.screen(path: "/titles/movie/101"))
    #expect(FileManager.default.createFile(atPath: signal.path(), contents: Data()))
    for request in [APIRequest.screen(path: "/titles/movie/101"), .screen(path: "/people")] {
      let error = await #expect(throws: APIError.self) { try await services.api.send(request) }
      #expect(error?.kind == .server(status: 502))
      #expect(error?.message == nil)
    }
    try FileManager.default.removeItem(at: signal)
    let after = try await services.api.send(.screen(path: "/titles/movie/101"))

    guard case .title(let page) = after.content else {
      Issue.record("\(after.content) is not a title page")
      return
    }
    #expect(page.title.name == "Night Crossing")
    #expect(after == before)
  }

  // A UI test keeps a change in flight while it chooses: while the holds
  // directory has a file at a request's path, that request waits, other
  // requests answer, and removing the file lets the held request answer.
  @Test func holdsARequestWhileItsFileExists() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let held = directory.appending(path: "api/screenr")
    try FileManager.default.createDirectory(at: held, withIntermediateDirectories: true)
    defer {
      do {
        try FileManager.default.removeItem(at: directory)
      } catch {
        Issue.record("Could not remove \(directory.path()): \(error)")
      }
    }
    let photo = held.appending(path: "photo")
    #expect(FileManager.default.createFile(atPath: photo.path(), contents: Data()))
    let services = try services("-ScreenrFixtureHolds", directory.path())
    let answers = Answers()

    let upload = Task {
      let saved = try await services.api.send(.uploadPhoto(jpeg: Data(count: 4000)))
      answers.record("photo")
      return saved
    }
    _ = try await services.api.send(.screen(path: "/account"))
    answers.record("account")
    try FileManager.default.removeItem(at: photo)
    let saved = try await upload.value

    #expect(answers.order == ["account", "photo"])
    #expect(saved.photo == "6b8351fef1a68536")
  }

  @Test func needsASignalForUpdates() {
    #expect(throws: FixtureError.self) {
      try FixtureTransport(
        directory: TestFixtures.directory,
        scenario: FixtureScenario(updates: ["screen/feed/incoming"])
      )
    }
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

  // Paged reads answer only as overrides, and a paged poll keeps the window
  // that last answered its path, as the server does.
  @Test func answersPagedReadsAsOverridesAndKeepsTheirWindow() async throws {
    let plain = try services("-ScreenrFixtureViewer", "nora")
    let fallback = try await plain.api.send(.screen(path: "/?before=now"))
    #expect(fallback.historyPage == HistoryPage(since: nil, older: false))
    #expect(fallback.feed?.conversations.isEmpty == true)

    let services = try services(
      "-ScreenrFixtureViewer",
      "nora",
      "-ScreenrFixtureOverride",
      "screen/feed/newest-page",
      "-ScreenrFixtureOverride",
      "screen/feed/older-page"
    )
    let since = "/?since=2026-10-13T12%3A00%3A00.000Z"
    let before = "/?before=2026-10-13T12%3A00%3A00.000Z"
    var counts: [Int?] = []
    for path in ["/?before=now", since, before, since] {
      counts.append(try await services.api.send(.screen(path: path)).feed?.conversations.count)
    }
    #expect(counts == [50, 50, 57, 57])
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

  // The app starts with a saved session the server no longer accepts.
  @Test func rejectsAnExpiredSessionUntilTheNextSignIn() async throws {
    let services = try services("-ScreenrFixtureSession", "expired")
    #expect(services.session.phase == .signedIn)

    let expired = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/"))
    }
    #expect(services.session.phase == .signedOut)
    #expect(services.session.ending == .expired)
    _ = try await services.api.send(.signIn(email: "alice@example.com", code: "123456"))
    let feed = try await services.api.send(.screen(path: "/"))

    #expect(expired?.kind == .signedOut)
    #expect(feed.user.username == "alice")
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
      providers: services.identity,
      browser: FailingAuthenticator(error: URLError(.badURL))
    )
    #expect(services.identity.authorization == .fixture)
    // Without a pickup scenario, the fixture API leaves the pickup out.
    #expect(services.identity.pickup == nil)

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
        callback: .customScheme(google.callbackScheme)
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
  // visit, and what it writes, Better Auth's routes included.
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
        POST /api/auth/email-otp/send-verification-otp {"email":"alice@example.com","type":"sign-in"}
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

  // Screenr Dev's extensions write to the log the app started, so a UI test
  // sees the app's and a share's or push's requests in order. Only the app's
  // launch starts an empty log.
  @Test(arguments: [AppServices.Host.shareExtension, .notificationExtension])
  func anExtensionAddsToTheAppsLog(_ host: AppServices.Host) async throws {
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
    let app = try services("-ScreenrFixtureLog", log.path())
    _ = try await app.api.send(.screen(path: "/titles/movie/101"))

    let later = try services("-ScreenrFixtureLog", log.path(), host: host)
    _ = try await later.api.send(.screen(path: "/titles/tv/201"))
    _ = try await app.api.send(.screen(path: "/"))
    let logged = try String(contentsOf: log, encoding: .utf8)

    #expect(
      logged == """
        GET /api/screenr/screen?path=%2Ftitles%2Fmovie%2F101 visit
        GET /api/screenr/screen?path=%2Ftitles%2Ftv%2F201
        GET /api/screenr/screen?path=%2F

        """
    )
    _ = try services("-ScreenrFixtureLog", log.path())
    let relaunched = try String(contentsOf: log, encoding: .utf8)
    #expect(relaunched == "")
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

  // A page or an action that no fixture answers gets the server's own
  // answer.
  @Test func answersAnUnknownPageOrActionAsTheServerDoes() async throws {
    let services = try services()

    let page = await #expect(throws: APIError.self) {
      try await services.api.send(.screen(path: "/nothing/here"))
    }
    let action = await #expect(throws: APIError.self) {
      try await services.api.send(
        APIRequest<Acknowledgement>(method: .post, endpoint: .action("no-such-action"))
      )
    }

    #expect(page?.kind == .notFound)
    #expect(page?.message == "Page not found.")
    #expect(action?.kind == .notFound)
    #expect(action?.message == "Action not found.")
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
        "-ScreenrFixturePush", "denied", "-ScreenrFixtureUpdate", "screen/feed/incoming",
        "-ScreenrFixtureUpdateSignal", "/tmp/update", "-ScreenrFixturePosters", "solid",
        "-ScreenrFixtureOutageSignal", "/tmp/outage", "-ScreenrFixtureHolds", "/tmp/holds",
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
            requestLog: URL(filePath: "/tmp/requests.log"),
            push: .denied,
            updates: ["screen/feed/incoming"],
            updateSignal: URL(filePath: "/tmp/update"),
            outageSignal: URL(filePath: "/tmp/outage"),
            holds: URL(filePath: "/tmp/holds", directoryHint: .isDirectory),
            posters: .solid
          )
        )
    )
  }

  // UI tests never see iOS's permission prompt: the fixture push system
  // reports the scenario's permission, and a member who has not decided
  // allows notifications when asked. It gets no device token. The `system`
  // choice keeps iOS's own, for checking pushes from `xcrun simctl push`.
  @Test @MainActor func reportsTheScenariosPushPermission() async throws {
    #expect(FixtureScenario().push == .undecided)

    let undecided = FixturePushSystem(permission: .undecided)
    #expect(await undecided.permission() == .undecided)
    #expect(try await undecided.requestPermission() == .allowed)
    #expect(await undecided.permission() == .allowed)

    let denied = FixturePushSystem(permission: .denied)
    #expect(try await denied.requestPermission() == .denied)

    #expect(FixtureScenario.Push.allowed.permission == .allowed)
    #expect(FixtureScenario.Push.system.permission == nil)
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

  @Test func choosesTheAppearanceAtLaunchInDev() {
    #expect(LaunchAppearance.colorScheme(in: ["Screenr"], variant: .dev) == nil)
    #expect(
      LaunchAppearance.colorScheme(in: ["Screenr", "-ScreenrAppearance", "dark"], variant: .dev)
        == .dark
    )
    #expect(
      LaunchAppearance.colorScheme(in: ["Screenr", "-ScreenrAppearance", "light"], variant: .dev)
        == .light
    )
    #expect(
      LaunchAppearance.colorScheme(
        in: ["Screenr", "-ScreenrAppearance", "dark"],
        variant: .release
      ) == nil
    )
    #expect(
      LaunchAppearance.colorScheme(in: ["Screenr", "-ScreenrAppearance"], variant: .dev) == nil
    )
  }

  @Test func showsTheAuditProbeAtLaunchInDev() {
    let arguments = ["Screenr", "-ScreenrAuditProbe", "faintClippedText"]
    #expect(AuditProbe.launch(in: arguments, variant: .dev) == .faintClippedText)
    #expect(AuditProbe.launch(in: arguments, variant: .release) == nil)
    #expect(AuditProbe.launch(in: ["Screenr"], variant: .dev) == nil)
    #expect(AuditProbe.launch(in: ["Screenr", "-ScreenrAuditProbe"], variant: .dev) == nil)
    #expect(AuditProbe.launch(in: ["Screenr", "-ScreenrAuditProbe", "x"], variant: .dev) == nil)
  }

  @Test func ignoresFixturesInRelease() throws {
    let arguments = ["Screenr", "-ScreenrFixtures", "/tmp/Fixtures"]
    #expect(try APISource(arguments: arguments, variant: .release) == .network)
  }

  @Test(arguments: [
    ["Screenr", "-ScreenrFixtures"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixtureSession", "maybe"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixtureColor", "red"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixturePush", "maybe"],
    ["Screenr", "-ScreenrFixtures", "/tmp", "-ScreenrFixturePosters", "real"],
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

// The order in which a test's requests answered.
@MainActor
private final class Answers {
  private(set) var order: [String] = []

  func record(_ name: String) {
    order.append(name)
  }
}
