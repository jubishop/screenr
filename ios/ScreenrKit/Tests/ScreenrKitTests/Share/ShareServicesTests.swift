import Foundation
import Testing

@testable import ScreenrKit

// The share extension's services: Screenr Dev hands its fixture arguments to
// the extension through the app group, the extension's client marks no
// visits, and shares in one process reuse one set of services.
@MainActor
struct ShareServicesTests {
  private let suite = "ScreenrKitTests.\(UUID().uuidString)"

  private func handoff(_ variant: AppConfiguration.Variant) throws -> FixtureHandoff {
    FixtureHandoff(defaults: try #require(UserDefaults(suiteName: suite)), variant: variant)
  }

  private func forget() {
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
  }

  // The extension's Info.plist settings, which have no APNs environment.
  private func configuration() throws -> AppConfiguration {
    try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
  }

  @Test func devHandsTheAppsFixtureArgumentsToItsExtension() throws {
    defer { forget() }
    try handoff(.dev)
      .keep([
        "Screenr", "-ScreenrFixtures", "/fixtures", "-ApplePersistenceIgnoreState", "YES",
        "-ScreenrFixtureViewer", "nora", "-ScreenrFixtureLog", "/tmp/requests.log",
      ])

    #expect(
      try handoff(.dev).arguments(["ScreenrShare"]) == [
        "ScreenrShare", "-ScreenrFixtures", "/fixtures", "-ScreenrFixtureViewer", "nora",
        "-ScreenrFixtureLog", "/tmp/requests.log",
      ]
    )
  }

  @Test func aLaunchWithoutFixturesForgetsThem() throws {
    defer { forget() }
    try handoff(.dev).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    try handoff(.dev).keep(["Screenr"])

    #expect(try handoff(.dev).arguments(["ScreenrShare"]) == ["ScreenrShare"])
  }

  @Test func releaseBuildsNeitherKeepNorReadThem() throws {
    defer { forget() }
    try handoff(.release).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    #expect(try handoff(.dev).arguments(["ScreenrShare"]) == ["ScreenrShare"])

    try handoff(.dev).keep(["Screenr", "-ScreenrFixtures", "/fixtures"])
    #expect(try handoff(.release).arguments(["ScreenrShare"]) == ["ScreenrShare"])
  }

  @Test func theExtensionsClientMarksNoVisit() async throws {
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
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrShare", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixtureLog",
        log.path(),
      ],
      host: .shareExtension
    )

    _ = try await services.api.send(.screen(path: "/titles/tv/201"))

    #expect(
      try String(contentsOf: log, encoding: .utf8)
        == "GET /api/screenr/screen?path=%2Ftitles%2Ftv%2F201\n"
    )
  }

  // Under the fixture API, how the extension ended each request goes to the
  // request log, where UI tests read it.
  @Test func fixtureServicesLogHowSharesEnded() throws {
    let log = FileManager.default.temporaryDirectory
      .appending(path: "share-endings-\(UUID().uuidString).log")
    defer {
      do {
        try FileManager.default.removeItem(at: log)
      } catch {
        Issue.record("Could not remove \(log.path()): \(error)")
      }
    }
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrShare", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixtureLog",
        log.path(),
      ],
      host: .shareExtension
    )

    services.shareEndings.report(.completed)
    services.shareEndings.report(.cancelled)

    #expect(try String(contentsOf: log, encoding: .utf8) == "SHARE completed\nSHARE cancelled\n")
  }

  // The extension handles no notifications, so it has no push system, even
  // when the app's fixture arguments choose a permission.
  @Test func theExtensionHasNoPushSystem() throws {
    let services = try AppServices(
      configuration: configuration(),
      arguments: [
        "ScreenrShare", "-ScreenrFixtures", TestFixtures.directory.path(), "-ScreenrFixturePush",
        "allowed",
      ],
      host: .shareExtension
    )

    #expect(services.push == nil)
  }

  // iOS may run several shares in one process, which reuse the first share's
  // client and image connections while the member's session stays the same.
  @Test func aLaterShareReusesTheServices() async throws {
    let builder = ServicesBuilder()
    let kept = ExtensionServices { try builder.services(arguments: $0) }
    var sessions: [SessionStore] = []

    for _ in 1...2 {
      try await kept.share(arguments: ["ScreenrShare"]) { share, services in
        sessions.append(services.session)
        share.close()
      }
    }

    #expect(sessions.count == 2)
    #expect(sessions.first === sessions.last)
    #expect(builder.transports.map(\.closed) == [0])
  }

  // A save in flight may already have reached the server, so a share whose
  // sheet closed mid-save keeps its services until the save answers, even
  // after the member signed in again in the app and a later share replaced
  // them. Then they close, and the share sends nothing more, such as the
  // page's read after the save.
  @Test(.timeLimit(.minutes(1)))
  func keepsReplacedServicesUntilTheSaveInFlightAnswers() async throws {
    let hold = Hold()
    let builder = ServicesBuilder(replies: [
      try TestFixtures.reply("screen/title/full-top-ten"),
      .held(hold, try TestFixtures.reply("actions/watch-status/watching")),
    ])
    let kept = ExtensionServices { try builder.services(arguments: $0) }
    let (opened, opening) = AsyncStream<ShareModel>.makeStream()
    let sharing = Task {
      try await kept.share(arguments: ["ScreenrShare"]) { share, _ in opening.yield(share) }
    }
    var shares = opened.makeAsyncIterator()
    let share = try #require(await shares.next())
    let page = share.page(for: try title("full-top-ten"))
    await page.load()
    let header = try #require(page.header)
    let saving = Task { await page.toggleWantToWatch(header) }
    await hold.arrival()

    share.close()
    try builder.keychain.write("next-token")
    try await kept.share(arguments: ["ScreenrShare"]) { later, _ in later.close() }
    #expect(builder.transports.map(\.closed) == [0, 0])

    hold.release()
    await saving.value
    try await sharing.value
    #expect(builder.transports.map(\.closed) == [1, 0])
    #expect(
      builder.transports.first?.requests.map { $0.url?.path() }
        == ["/api/screenr/screen", "/api/screenr/watch-status"]
    )
  }

  // The title a title page fixture shows.
  private func title(_ fixture: String) throws -> Title {
    guard case .title(let page) = try screen("screen/title/\(fixture)").content else {
      throw FeedFixtureError(description: "\(fixture) is not a title page")
    }
    return page.title
  }
}
