import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ShellModelTests {
  // The real client against the fixture API.
  private func shell(
    _ scenario: FixtureScenario = FixtureScenario(),
    token: String = FixtureTransport.token,
    clock: TestClock = TestClock()
  ) throws -> (ShellModel, SessionStore) {
    let session = try SessionStore(keychain: InMemoryKeychain(token: token))
    let client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: session,
      transport: try FixtureTransport(directory: TestFixtures.directory, scenario: scenario)
    )
    return (ShellModel(api: client, clock: clock), session)
  }

  @Test func readsTheFeedToFindTheViewer() async throws {
    let (shell, _) = try shell()
    #expect(shell.account == .checking)

    await shell.checkAccount()

    #expect(shell.account == .ready)
    #expect(shell.viewer?.username == "alice")
    #expect(shell.router.viewerUsername == "alice")
    #expect(shell.router.root(of: .you) == .profile(username: "alice"))
    #expect(shell.unreadNotifications == 6)
  }

  @Test func sendsAMemberWithoutAProfileToSetup() async throws {
    let (shell, _) = try shell(
      FixtureScenario(viewer: "pat", failure: "errors/incomplete-profile")
    )

    await shell.checkAccount()

    #expect(shell.account == .needsSetup)
    #expect(shell.viewer == nil)
  }

  @Test func offersToTryAgainWhenTheCheckFails() async throws {
    let api = ScriptedAPI([.failure(.offline), .screen(try screen("screen/feed/default"))])
    let shell = ShellModel(api: api, clock: TestClock())

    await shell.checkAccount()
    guard case .failed(let error) = shell.account else {
      Issue.record("The failed check left \(shell.account)")
      return
    }
    #expect(error.kind == .offline)

    await shell.checkAccount()
    #expect(shell.account == .ready)
  }

  @Test func leavesAnEndedSessionToTheSessionPhase() async throws {
    let api = ScriptedAPI([.failure(.signedOut)])
    let shell = ShellModel(api: api, clock: TestClock())

    await shell.checkAccount()

    #expect(shell.account == .checking)
  }

  @Test func followsTheUnreadCountOfEveryLoadedScreen() async throws {
    let clock = TestClock()
    let (shell, _) = try shell(FixtureScenario(viewer: "nora"), clock: clock)
    await shell.checkAccount()
    #expect(shell.unreadNotifications == 0)
    let model = try #require(shell.screenModel(for: .people))
    #expect(model.path == "/people")

    let alice = try screen("screen/people/default")
    shell.screenLoaded(alice)

    #expect(shell.unreadNotifications == 6)
    #expect(shell.viewer?.username == "alice")
    shell.setUnreadNotifications(2)
    #expect(shell.unreadNotifications == 2)
  }

  @Test func makesScreenModelsThatReportToTheShell() async throws {
    let clock = TestClock()
    let (shell, _) = try shell(clock: clock)
    let model = try #require(shell.screenModel(for: .title(id: "tv:201")))

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))

    #expect(model.path == "/titles/tv/201")
    #expect(shell.unreadNotifications == 6)
    #expect(shell.screenModel(for: .join(token: "token")) == nil)
    #expect(shell.screenModel(for: .notFound(path: "/unknown")) == nil)
  }

  // The app names the signed-in member's opaque user ID in error reports.
  @Test func reportsEachNewViewerOnce() async throws {
    let viewers = Mutex<[String]>([])
    let api = ScriptedAPI([
      .screen(try screen("screen/feed/default")), .screen(try screen("screen/people/default")),
      .screen(try screen("screen/feed/empty")),
    ])
    let shell = ShellModel(api: api, clock: TestClock()) { person in
      viewers.withLock { $0.append(person.userId) }
    }

    await shell.checkAccount()
    await shell.checkAccount()
    shell.sessionEnded(.signedOut)
    await shell.checkAccount()

    #expect(viewers.withLock { $0 } == ["user-alice", "user-nora"])
  }

  // Spotlight sees every screen that loads, polls included.
  @Test func reportsEveryLoadedScreen() async throws {
    let seen = Mutex<[String]>([])
    let api = ScriptedAPI([
      .screen(try screen("screen/feed/default")), .screen(try screen("screen/title/tv")),
    ])
    let clock = TestClock()
    let shell = ShellModel(
      api: api,
      clock: clock,
      onScreen: { screen in
        let name = if case .title(let page) = screen.content { page.title.id } else { "feed" }
        seen.withLock { $0.append(name) }
      }
    )

    await shell.checkAccount()
    let model = try #require(shell.screenModel(for: .title(id: "tv:201")))
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    clock.advance(by: .seconds(3))
    await api.waitForReads(3)
    await clock.waitForSleep(until: .seconds(6))
    model.disappeared()

    #expect(seen.withLock { $0 } == ["feed", "tv:201", "tv:201"])
  }

  @Test func followsTheAppsActivity() throws {
    let (shell, _) = try shell()
    #expect(!shell.isAppActive)

    shell.appActivityChanged(true)
    #expect(shell.isAppActive)
    shell.appActivityChanged(false)
    #expect(!shell.isAppActive)
  }

  @Test func asksLiveScreensToRefreshWhenAPushArrives() throws {
    let (shell, _) = try shell()
    let before = shell.liveRefreshes

    shell.pushArrived()

    #expect(shell.liveRefreshes == before + 1)
  }

  // A link that arrives at launch, before the account check names the viewer,
  // opens where it would for a member already using the app.
  @Test(arguments: [
    (Destination.title(id: "tv:201"), AppTab.circle, [Destination.title(id: "tv:201")]),
    (.profile(username: "alice"), .you, []),
    (.wantToWatch(username: "alice"), .you, [.wantToWatch(username: "alice")]),
  ])
  func opensALinkFromLaunchOnceTheAccountCheckNamesTheViewer(
    _ link: Destination,
    in tab: AppTab,
    above path: [Destination]
  ) async throws {
    let (shell, _) = try shell()
    shell.router.open(link)

    await shell.checkAccount()

    #expect(shell.account == .ready)
    #expect(shell.router.selectedTab == tab)
    #expect(shell.router[stack: tab] == path)
  }

  // A member whose saved session expired follows a link. The account check's
  // 401 ends the session, and the link opens once they sign in again.
  @Test(arguments: [
    (Destination.title(id: "tv:201"), AppTab.circle, [Destination.title(id: "tv:201")]),
    (.profile(username: "alice"), .you, []),
    (.wantToWatch(username: "alice"), .you, [.wantToWatch(username: "alice")]),
  ])
  func opensALinkAfterSigningInAgainWhenTheSessionExpired(
    _ link: Destination,
    in tab: AppTab,
    above path: [Destination]
  ) async throws {
    let (shell, session) = try shell(
      FixtureScenario(session: .expired),
      token: FixtureTransport.expiredToken
    )
    session.onEnd { shell.sessionEnded($0) }
    shell.router.open(link)

    await shell.checkAccount()
    #expect(session.phase == .signedOut)
    _ = try await shell.api.send(.signIn(email: "alice@example.test", code: "123456"))
    await shell.checkAccount()

    #expect(shell.account == .ready)
    #expect(shell.router.selectedTab == tab)
    #expect(shell.router[stack: tab] == path)
  }

  // A link whose screen loaded reached the member, so the next sign-in
  // starts at Circle.
  @Test func forgetsALinkWhoseScreenLoadedWhenTheSessionExpires() async throws {
    let clock = TestClock()
    let (shell, _) = try shell(clock: clock)
    await shell.checkAccount()
    shell.router.open(.title(id: "tv:201"))
    let model = try #require(shell.screenModel(for: .title(id: "tv:201")))

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    model.disappeared()
    shell.sessionEnded(.expired)

    #expect(shell.router.paths.values.allSatisfy { $0.isEmpty })
  }

  // A screen can answer just after the session ends, such as the one beneath
  // Settings as the member signs out. It reports nothing to the shell, so the
  // member does not come back.
  @Test func ignoresAScreenThatAnswersAfterTheSessionEnds() async throws {
    let hold = Hold()
    defer { hold.release() }
    let api = ScriptedAPI([
      .screen(try screen("screen/feed/default")),
      .held(hold, try screen("screen/people/default")),
      .screen(try screen("screen/people/default")),
    ])
    let clock = TestClock()
    var viewers: [String] = []
    let shell = ShellModel(api: api, clock: clock) { viewers.append($0.userId) }
    await shell.checkAccount()
    let model = try #require(shell.screenModel(for: .people))
    model.appeared(appActive: true)
    await hold.arrival()

    shell.sessionEnded(.signedOut)
    hold.release()
    await clock.waitForSleep(until: .seconds(3))

    #expect(shell.viewer == nil)
    #expect(shell.router.viewerUsername == nil)
    #expect(shell.unreadNotifications == 0)
    #expect(viewers == ["user-alice"])
  }

  @Test func ignoresAnAccountCheckThatAnswersAfterTheSessionEnds() async throws {
    let hold = Hold()
    defer { hold.release() }
    let api = ScriptedAPI([
      .held(hold, try screen("screen/feed/default")), .screen(try screen("screen/feed/default")),
    ])
    let shell = ShellModel(api: api, clock: TestClock())
    let check = Task { await shell.checkAccount() }
    await hold.arrival()

    shell.sessionEnded(.signedOut)
    hold.release()
    await check.value

    #expect(shell.account == .checking)
    #expect(shell.viewer == nil)
    // The next session's check is its own.
    await shell.checkAccount()
    #expect(shell.account == .ready)
  }

  @Test func startsOverWhenTheMemberSignsOut() async throws {
    let (shell, _) = try shell()
    await shell.checkAccount()
    shell.router.open(.title(id: "tv:201"))
    shell.leaveNotice("You blocked Ben Ortiz.", on: .people)

    shell.sessionEnded(.signedOut)

    #expect(shell.notices.isEmpty)
    #expect(shell.account == .checking)
    #expect(shell.viewer == nil)
    #expect(shell.unreadNotifications == 0)
    #expect(shell.router.paths.values.allSatisfy { $0.isEmpty })
    #expect(shell.router.root(of: .you) == nil)
  }

  // A result waits for its screen until the reader dismisses it.
  @Test func keepsANoticeForItsScreen() throws {
    let (shell, _) = try shell()

    shell.leaveNotice("You blocked Ben Ortiz.", on: .people)
    #expect(shell.notices == [.people: "You blocked Ben Ortiz."])
    shell.dismissNotice(on: .feed())
    #expect(shell.notices[.people] == "You blocked Ben Ortiz.")

    shell.dismissNotice(on: .people)
    #expect(shell.notices.isEmpty)
  }
}
