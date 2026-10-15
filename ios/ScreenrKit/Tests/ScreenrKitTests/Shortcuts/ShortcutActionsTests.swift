import Foundation
import Testing

@testable import ScreenrKit

// Siri's and the Shortcuts app's actions against the fixture API, whose
// request log shows what each one read and wrote.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ShortcutActionsTests {
  // The actions, the request log, and what reached Spotlight.
  private struct Harness {
    let actions: ShortcutActions
    let services: AppServices
    let router: Router
    let spotlight: TitleSpotlight
    let index: RecordingTitleIndex
    let log: URL

    // The request log's lines so far.
    func requests() throws -> [String] {
      guard FileManager.default.fileExists(atPath: log.path()) else { return [] }
      return try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map(String.init)
    }
  }

  private func harness(_ arguments: String...) throws -> Harness {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])
    let log = FileManager.default.temporaryDirectory
      .appending(path: "shortcuts-\(UUID().uuidString).log")
    let services = try AppServices(
      configuration: configuration,
      arguments: ["Screenr", "-ScreenrFixtures", TestFixtures.directory.path()]
        + ["-ScreenrFixtureLog", log.path()] + arguments
    )
    let index = RecordingTitleIndex()
    let spotlight = TitleSpotlight(index: index, session: services.session)
    let router = Router()
    let actions = ShortcutActions(
      api: services.api,
      session: services.session,
      router: router,
      spotlight: spotlight
    )
    return Harness(
      actions: actions,
      services: services,
      router: router,
      spotlight: spotlight,
      index: index,
      log: log
    )
  }

  private func cleanUp(_ harness: Harness) throws {
    guard FileManager.default.fileExists(atPath: harness.log.path()) else { return }
    try FileManager.default.removeItem(at: harness.log)
  }

  @Test func searchesTheCatalogByName() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    let titles = try await harness.actions.search("  night ")
    let short = try await harness.actions.search(" n ")

    #expect(titles.map(\.name) == ["Night Crossing", "Night Harbor"])
    #expect(titles.map(\.details) == ["Movie · 2024", "TV show · 2018"])
    #expect(short.isEmpty)
    #expect(try harness.requests() == ["GET /api/screenr/search?q=night"])
  }

  // A shortcut keeps its titles' IDs and reads them again from their pages.
  // Those reads are never the app's visit, which stays due for the app's
  // next screen.
  @Test func readsTitlesFromTheirPagesWithoutAVisit() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    let titles = try await harness.actions.titles([
      "movie:101", "people/ben", "movie:999", "tv:201",
    ])
    _ = try await harness.services.api.send(.screen(path: "/"))

    #expect(titles.map(\.name) == ["Night Crossing", "Harbor Lights"])
    #expect(
      try harness.requests() == [
        "GET /api/screenr/screen?path=%2Ftitles%2Fmovie%2F101",
        "GET /api/screenr/screen?path=%2Ftitles%2Fmovie%2F999",
        "GET /api/screenr/screen?path=%2Ftitles%2Ftv%2F201",
        "GET /api/screenr/screen?path=%2F visit",
      ]
    )
  }

  // The picker suggests what friends recommend that Alice could still save:
  // not Night Crossing or Harbor Lights, which she recommends.
  @Test func suggestsFriendsRecommendationsTheMemberCouldSave() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    let suggestions = try await harness.actions.wantToWatchSuggestions()

    #expect(suggestions.map(\.name) == ["Winter Garden"])
    #expect(try harness.requests() == ["GET /api/screenr/screen?path=%2Fsearch"])
  }

  @Test func savesATitleToWantToWatchFromTheShortcutSurface() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    let found = try await harness.actions.search("winter")
    #expect(found.map(\.name) == ["Winter Garden", "The Long Winter"])
    let result = try await harness.actions.addToWantToWatch(try #require(found.first).id)

    guard case .saved(let title) = result else {
      Issue.record("Saving Winter Garden returned \(result)")
      return
    }
    #expect(title.name == "Winter Garden")
    #expect(result.message == "Added Winter Garden to Want to watch.")
    #expect(
      try harness.requests() == [
        "GET /api/screenr/search?q=winter",
        "GET /api/screenr/screen?path=%2Ftitles%2Fmovie%2F105",
        #"POST /api/screenr/activity {"field":"want_to_watch","surface":"shortcut","#
          + #""title":"movie:105","value":true}"#,
      ]
    )
    // The saved title joins Spotlight.
    await harness.spotlight.finishWrites()
    #expect(harness.index.titles.map(\.id) == ["movie:105"])
  }

  // Want to watch never replaces the member's Recommend or another status;
  // only the title page changes those.
  @Test func leavesARecommendOrAnotherStatusInPlace() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    let saved = try await harness.actions.addToWantToWatch("movie:104")
    let finished = try await harness.actions.addToWantToWatch("movie:102")
    let recommended = try await harness.actions.addToWantToWatch("movie:101")

    #expect(saved == .alreadySaved(saved.title))
    #expect(saved.message == "Glass Meridian is already in your Want to watch.")
    #expect(finished == .otherStatus(finished.title, .finished))
    #expect(
      finished.message
        == "Your status for Paper Lanterns is Finished. To save it to Want to watch instead, "
        + "change its status on its page in Screenr."
    )
    #expect(recommended == .recommended(recommended.title))
    #expect(
      recommended.message
        == "You recommend Night Crossing. To save it to Want to watch instead, change it on "
        + "its page in Screenr."
    )
    #expect(try harness.requests().allSatisfy { $0.hasPrefix("GET ") })
  }

  @Test func reportsAnUnknownTitle() async throws {
    let harness = try harness()
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    await #expect(throws: ShortcutActions.Failure.unknownTitle) {
      try await harness.actions.addToWantToWatch("movie:999")
    }
    // An ID that names no title never reaches the server.
    await #expect(throws: ShortcutActions.Failure.unknownTitle) {
      try await harness.actions.addToWantToWatch("people/ben")
    }
    #expect(try harness.requests() == ["GET /api/screenr/screen?path=%2Ftitles%2Fmovie%2F999"])
    #expect(
      ShortcutActions.Failure.unknownTitle.message == "Screenr couldn’t find that movie or show."
    )
  }

  @Test func namesTheFirstTitlesFriendsRecommend() async throws {
    let alice = try harness()
    let cam = try harness("-ScreenrFixtureViewer", "cam")
    let nora = try harness("-ScreenrFixtureViewer", "nora")
    defer {
      for harness in [alice, cam, nora] { #expect(throws: Never.self) { try cleanUp(harness) } }
    }

    let three = try await alice.actions.friendsRecommend()
    let many = try await cam.actions.friendsRecommend()
    let none = try await nora.actions.friendsRecommend()

    #expect(three.titles.map(\.id) == ["movie:101", "tv:201", "movie:105"])
    #expect(
      three.message == "Your friends recommend Night Crossing, Harbor Lights, and Winter Garden."
    )
    #expect(
      many.message
        == "Your friends recommend Night Crossing, Harbor Lights, Copper Coast, and 10 more."
    )
    #expect(none.titles.isEmpty)
    #expect(none.message == "No recommendations yet.")
    // The read is not a visit.
    #expect(try alice.requests() == ["GET /api/screenr/screen?path=%2Fsearch"])
  }

  // As the tab first shows them, finished titles are left out.
  @Test func leavesOutFinishedRecommendations() async throws {
    let body = try JSONDecoder()
      .decode(
        JSONValue.self,
        from: try TestFixtures.body("screen/search/default")
      )
    guard case .array(let recommendations)? = body.member("recommendations") else {
      Issue.record("The search fixture has no recommendations")
      return
    }
    let finishedFirst = recommendations.enumerated()
      .map { offset, title in
        title.merging(["viewer_status": offset < 2 ? "finished" : .null])
      }
    let allFinished = recommendations.map { $0.merging(["viewer_status": "finished"]) }
    let screens = try [finishedFirst, allFinished]
      .map { titles in
        try ScreenrJSON.decoder()
          .decode(
            Screen.self,
            from: try JSONEncoder().encode(body.merging(["recommendations": .array(titles)]))
          )
      }
    let session = try SessionStore(keychain: InMemoryKeychain(token: "signed-token"))
    let api = ScriptedAPI(screens.map { .screen($0) })
    let actions = ShortcutActions(api: api, session: session, router: Router())

    let one = try await actions.friendsRecommend()
    let finished = try await actions.friendsRecommend()

    #expect(one.titles.map(\.id) == ["movie:105"])
    #expect(one.message == "Your friends recommend Winter Garden.")
    #expect(finished.titles.isEmpty)
    #expect(finished.message == "You finished every title your friends recommend.")
  }

  @Test func opensFriendsRecommend() throws {
    let harness = try harness()
    harness.router.selectedTab = .circle

    try harness.actions.openFriendsRecommend()

    #expect(harness.router.selectedTab == .find)
    #expect(harness.router.findSearch == .search(tab: .friendsRecommend))
  }

  @Test func asksASignedOutMemberToSignIn() async throws {
    let harness = try harness("-ScreenrFixtureSession", "signedOut")
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    await #expect(throws: ShortcutActions.Failure.signedOut) {
      try await harness.actions.search("night")
    }
    await #expect(throws: ShortcutActions.Failure.signedOut) {
      try await harness.actions.addToWantToWatch("movie:105")
    }
    await #expect(throws: ShortcutActions.Failure.signedOut) {
      try await harness.actions.friendsRecommend()
    }
    #expect(throws: ShortcutActions.Failure.signedOut) {
      try harness.actions.openFriendsRecommend()
    }
    #expect(harness.router.selectedTab == .circle)
    #expect(try harness.requests().isEmpty)
    // Siri and the Shortcuts app show the message.
    #expect(
      String(localized: ShortcutActions.Failure.signedOut.localizedStringResource)
        == "Sign in to Screenr to use this shortcut."
    )
  }

  @Test func asksForAnUpdateTheServerRequires() async throws {
    let harness = try harness("-ScreenrFixtureFailure", "errors/update-required")
    defer { #expect(throws: Never.self) { try cleanUp(harness) } }

    await #expect(throws: ShortcutActions.Failure.updateRequired) {
      try await harness.actions.search("night")
    }
    // The session now requires the update, so nothing else is sent.
    await #expect(throws: ShortcutActions.Failure.updateRequired) {
      try await harness.actions.friendsRecommend()
    }
    #expect(try harness.requests() == ["GET /api/screenr/search?q=night"])
  }

  @Test func explainsOtherFailures() async throws {
    let session = try SessionStore(keychain: InMemoryKeychain(token: "signed-token"))
    let actions = ShortcutActions(
      api: ScriptedAPI([.failure(.offline), .failure(.server(status: 500))]),
      session: session,
      router: Router()
    )

    await #expect(
      throws: ShortcutActions.Failure.failed("You’re offline. Check your connection and try again.")
    ) {
      try await actions.addToWantToWatch("movie:105")
    }
    await #expect(
      throws: ShortcutActions.Failure.failed("Screenr is having trouble right now. Try again soon.")
    ) {
      try await actions.friendsRecommend()
    }
  }
}
