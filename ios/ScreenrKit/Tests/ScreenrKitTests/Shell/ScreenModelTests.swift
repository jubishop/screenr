import Foundation
import Observation
import Synchronization
import Testing

@testable import ScreenrKit

// The visible screen polls every three seconds while the app is active, as the
// web's open pages do while visible. A wait the clock never reaches fails the
// test at its time limit instead of hanging.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ScreenModelTests {
  let feed: Screen
  let emptyFeed: Screen

  init() throws {
    feed = try screen("screen/feed/default")
    emptyFeed = try screen("screen/feed/empty")
  }

  @Test func readsWhenItAppearsAndPollsEveryThreeSeconds() async throws {
    let api = ScriptedAPI([.screen(feed), .screen(feed), .screen(emptyFeed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    #expect(model.phase == .loading)

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    #expect(api.reads == ["/"])
    #expect(model.phase == .loaded(feed))

    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(9))

    #expect(api.reads == ["/", "/", "/"])
    #expect(model.phase == .loaded(emptyFeed))
  }

  @Test func stopsPollingInTheBackgroundAndRefreshesOnReturning() async throws {
    let api = ScriptedAPI([.screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))
    let polling = try #require(model.pollTask)

    model.appActivityChanged(false)
    await finish(polling)
    clock.advance(by: .seconds(30))

    #expect(model.pollTask == nil)
    #expect(clock.sleeping == 0)
    #expect(api.reads.count == 2)

    model.appActivityChanged(true)
    await clock.waitForSleep(until: .seconds(36))
    #expect(api.reads.count == 3)
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(39))
    #expect(api.reads.count == 4)
  }

  @Test func waitsForTheAppToBecomeActive() async throws {
    let api = ScriptedAPI([.screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)

    model.appeared(appActive: false)
    #expect(model.pollTask == nil)
    model.appActivityChanged(true)
    await clock.waitForSleep(until: .seconds(3))

    #expect(api.reads == ["/"])
  }

  @Test func stopsPollingWhenItDisappearsAndRefreshesWhenItReturns() async throws {
    let api = ScriptedAPI([.screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    let polling = try #require(model.pollTask)

    model.disappeared()
    await finish(polling)
    clock.advance(by: .seconds(30))
    #expect(api.reads.count == 1)
    // A screen that disappears keeps its data for its return.
    #expect(model.phase == .loaded(feed))

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(33))
    #expect(api.reads.count == 2)
  }

  @Test func keepsPollingThroughPassingFailuresWithoutTheOldContent() async throws {
    let api = ScriptedAPI([.screen(feed), .failure(.offline), .screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))

    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))
    guard case .failed(let error) = model.phase else {
      Issue.record("The failed refresh kept \(model.phase)")
      return
    }
    #expect(error.kind == .offline)

    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(9))
    #expect(model.phase == .loaded(feed))
  }

  @Test func stopsPollingAfterAPermanentErrorUntilARefreshSucceeds() async throws {
    let api = ScriptedAPI([.screen(feed), .failure(.notFound), .screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    let polling = try #require(model.pollTask)

    clock.advance(by: .seconds(3))
    await finish(polling)
    clock.advance(by: .seconds(30))
    #expect(model.pollTask == nil)
    #expect(api.reads.count == 2)
    guard case .failed(let error) = model.phase else {
      Issue.record("The permanent error kept \(model.phase)")
      return
    }
    #expect(error.kind == .notFound)

    await model.refresh()
    #expect(model.phase == .loaded(feed))
    await clock.waitForSleep(until: .seconds(36))
    #expect(api.reads.count == 3)
  }

  @Test func givesUpOnARefreshAfterTenSeconds() async throws {
    let api = ScriptedAPI([.screen(feed), .hang, .screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))

    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(13))
    clock.advance(by: .seconds(10))
    await clock.waitForSleep(until: .seconds(16))

    guard case .failed(let error) = model.phase else {
      Issue.record("The stalled refresh kept \(model.phase)")
      return
    }
    #expect(error.kind == .timedOut)
    #expect(error.requestID == "request-2")
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(19))
    #expect(model.phase == .loaded(feed))
  }

  // A poll that started before a write may have missed it, so a refresh after
  // the write reads again instead of joining it.
  @Test func refreshesWithANewReadInsteadOfJoiningOneInFlight() async throws {
    let api = ScriptedAPI([.screen(feed), .hang, .screen(emptyFeed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    clock.advance(by: .seconds(3))
    await api.waitForReads(2)

    await model.refresh()

    #expect(api.reads.count == 3)
    #expect(model.phase == .loaded(emptyFeed))
  }

  @Test func keepsItsDataWhenTheScreenIsUnchanged() async throws {
    let api = ScriptedAPI([.screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    let changes = Mutex(0)
    withObservationTracking {
      _ = model.phase
    } onChange: {
      changes.withLock { $0 += 1 }
    }

    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))

    #expect(api.reads.count == 2)
    #expect(changes.withLock { $0 } == 0)
  }

  @Test func refreshesAtOnceWhenAPushArrives() async throws {
    let api = ScriptedAPI([.screen(feed), .screen(emptyFeed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))

    model.refreshIfLive()
    await api.waitForReads(2)
    await clock.waitForSleep(until: .seconds(3))

    #expect(model.phase == .loaded(emptyFeed))
  }

  @Test func ignoresAPushWhileHidden() async throws {
    let api = ScriptedAPI([.screen(feed)])
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: api, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    let polling = try #require(model.pollTask)
    model.disappeared()
    await finish(polling)

    model.refreshIfLive()

    #expect(model.pollTask == nil)
    #expect(api.reads.count == 1)
  }

  @Test func namesTheScreenARedirectOpens() async throws {
    let redirect = try screen("screen/conversation/redirect")
    let api = ScriptedAPI([.screen(redirect)])
    let clock = TestClock()
    let model = ScreenModel(path: "/conversations/legacy", api: api, clock: clock)
    #expect(model.screen == nil)

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))

    #expect(model.screen == redirect)
    #expect(model.redirectPath == "/titles/movie/101?item=0601645c-005d-450f-8b22-ae05a508119d")
  }

  // Other live reads, such as the notifications sheet's, poll the same way.
  @Test func pollsAnyRead() async throws {
    let session = try SessionStore(keychain: InMemoryKeychain(token: FixtureTransport.token))
    let observer = RecordingObserver()
    let client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: session,
      transport: try FixtureTransport(directory: TestFixtures.directory),
      observer: observer
    )
    let clock = TestClock()
    let model = LiveRead(.notifications(), api: client, clock: clock)

    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))

    #expect(model.value?.items.isEmpty == false)
    #expect(
      observer.records.map(\.route) == ["/api/screenr/notifications", "/api/screenr/notifications"]
    )
    #expect(observer.records.map(\.status) == [200, 304])
    model.disappeared()
  }

  @Test func reportsEachLoadedScreen() async throws {
    let api = ScriptedAPI([.screen(feed), .screen(emptyFeed)])
    let clock = TestClock()
    let loaded = Mutex<[Screen]>([])
    let model = ScreenModel(path: "/", api: api, clock: clock) { screen in
      loaded.withLock { $0.append(screen) }
    }
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    clock.advance(by: .seconds(3))
    await clock.waitForSleep(until: .seconds(6))

    #expect(loaded.withLock { $0 } == [feed, emptyFeed])
  }
}
