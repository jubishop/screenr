import Foundation
import XCTest

// The app shell: tabs, toolbars, links to every destination, polling, and the
// screens before the tabs. These tests read which screens the app requested
// from the fixture API's log, and check navigation titles and tabs, so they
// hold whatever each feature screen shows.
final class ShellTests: XCTestCase {
  // An entry that the fixtures name, and its old conversation link.
  private let entry = "0601645c-005d-450f-8b22-ae05a508119d"

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSwitchesTabsWithTheirToolbars() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))

    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["screenr"].exists)
    XCTAssertTrue(app.tab("Circle").isSelected)
    XCTAssertEqual(app.buttons["bell"].value as? String, "6 items")
    try app.performShellAudit()

    app.tab("Friends").tap()
    XCTAssertTrue(app.navigationBars["Friends"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["bell"].exists)
    XCTAssertFalse(app.buttons["Settings"].exists)
    try app.performShellAudit()

    app.tab("You").tap()
    XCTAssertTrue(app.navigationBars["Alice Park"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["bell"].exists)
    try app.performShellAudit()

    app.buttons["Settings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    try app.performSettingsAudit()
    app.buttons["Close"].tap()

    // Find a title opens with its search active, which hides the bar's
    // buttons until the search closes.
    app.tab("Find a title").tap()
    XCTAssertTrue(app.navigationBars["Find a title"].waitForExistence(timeout: 10))
    app.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["bell"].waitForExistence(timeout: 10))
    try app.performShellAudit()

    app.buttons["bell"].tap()
    XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 10))
    try app.performShellAudit()
    app.buttons["Close"].tap()
    XCTAssertTrue(app.navigationBars["Find a title"].waitForExistence(timeout: 10))

    wait(
      for: [
        log.expectation { paths in
          ["/", "/people", "/people/alice", "/account", "/search"].allSatisfy(paths.contains)
        }
      ],
      timeout: 10
    )
  }

  // Links arrive through onOpenURL while the app runs, as universal links and
  // screenr-dev:// links do.
  @MainActor
  func testOpensALinkToEachKindOfDestination() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))

    // Titles, other people, and unknown paths open on the current tab.
    app.tab("Friends").tap()
    try open(
      app,
      "titles/movie/101?item=\(entry)&reply=5",
      reads: "/titles/movie/101?item=\(entry)&reply=5",
      log: log,
      title: "Night Crossing",
      tab: "Friends"
    )
    XCTAssertTrue(app.buttons["Share"].exists)
    try app.performShellAudit()
    try open(app, "people/ben", reads: "/people/ben", log: log, title: "Ben Ortiz", tab: "Friends")
    open(app, "nothing/here")
    XCTAssertTrue(app.staticTexts["Page not found"].waitForExistence(timeout: 10))
    try app.performShellAudit()

    // Each tab keeps its stack.
    app.tab("Circle").tap()
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.tab("Friends").tap()
    XCTAssertTrue(app.staticTexts["Page not found"].waitForExistence(timeout: 10))
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Ben Ortiz"].waitForExistence(timeout: 10))

    // An old conversation link becomes its entry's permalink.
    try open(
      app,
      "conversations/\(entry)",
      reads: "/titles/movie/101?item=\(entry)",
      log: log,
      title: "Night Crossing",
      tab: "Friends"
    )

    // Tab screens open at their tab's root, with a feed entry above it.
    try open(
      app,
      "?item=\(entry)&reply=8",
      reads: "/?item=\(entry)&reply=8",
      log: log,
      title: "Your circle",
      tab: "Circle"
    )
    try open(
      app,
      "search?q=Lost&tab=friends-recommend",
      reads: "/search",
      log: log,
      title: "Find a title",
      tab: "Find a title"
    )
    XCTAssertEqual(app.searchFields.firstMatch.value as? String, "Lost")
    try open(app, "people", reads: "/people", log: log, title: "Friends", tab: "Friends")
    try open(app, "people/alice", reads: "/people/alice", log: log, title: "Alice Park", tab: "You")

    // Friends pages open in Friends.
    try open(
      app,
      "watch-together?with=ben",
      reads: "/watch-together?with=ben",
      log: log,
      title: "Watch together",
      tab: "Friends"
    )
    try open(app, "invites", reads: "/invites", log: log, title: "Invite friends", tab: "Friends")

    // Account opens Settings over You.
    try open(app, "account", reads: "/account", log: log, title: "Settings", tab: "You")
    app.buttons["Close"].tap()

    // A member who already has a profile lands in Circle from an invitation.
    open(app, "join/AbC_123-xyz")
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Circle").isSelected)
  }

  // UI tests can start at any destination with -ScreenrOpenURL.
  @MainActor
  func testOpensALinkAtLaunch() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(link: "screenr-dev://titles/tv/201?item=\(entry)", requestLog: log.file)
    )

    XCTAssertTrue(app.navigationBars["Harbor Lights"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Circle").isSelected)
    wait(for: [log.read("/titles/tv/201?item=\(entry)")], timeout: 10)
  }

  @MainActor
  func testKeepsAnInvitationForSignIn() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(session: .signedOut, link: "screenr-dev://join/AbC_123-xyz"))

    XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts[
        "You’re invited. Sign in to find your people and something worth watching."
      ]
      .exists
    )
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    try app.performAccessibilityAudit()
  }

  @MainActor
  func testSendsAMemberWithoutAProfileToSetup() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(viewer: "pat", failure: "errors/incomplete-profile"))

    XCTAssertTrue(app.staticTexts["What should friends call you?"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    try app.performAccessibilityAudit()
  }

  @MainActor
  func testShowsTheRequiredUpdateScreen() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(failure: "errors/update-required"))

    XCTAssertTrue(app.staticTexts["Update Screenr"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Open TestFlight"].exists)
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    try app.performAccessibilityAudit()
  }

  // The visible screen polls every three seconds while the app is active,
  // stops in the background, and reads again on returning. Only the first
  // screen read after launch, and the first after the return, is a visit for
  // usage telemetry. ScreenrKit's ScreenModelTests cover the timing with a
  // test clock, and VisitTests the visit rules.
  @MainActor
  func testPollsOnlyWhileTheAppIsActiveAndMarksVisits() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    // The account check, the feed's first read, and a poll.
    wait(for: [log.screenReads(atLeast: 3)], timeout: 15)
    XCTAssertEqual(try log.visits(), [0])

    XCUIDevice.shared.press(.home)
    let background = NSPredicate { _, _ in app.state != .runningForeground }
    wait(for: [XCTNSPredicateExpectation(predicate: background, object: nil)], timeout: 10)
    let reads = try log.screenPaths().count
    let pollInBackground = log.screenReads(atLeast: reads + 1)
    pollInBackground.isInverted = true
    wait(for: [pollInBackground], timeout: 7)

    app.activate()
    // The read on returning, and a poll.
    wait(for: [log.screenReads(atLeast: reads + 2)], timeout: 8)
    XCTAssertEqual(try log.visits(), [0, reads])
  }

  // Opens a screenr-dev:// link and checks the screen it read, its title, and
  // its tab.
  @MainActor
  private func open(
    _ app: XCUIApplication,
    _ link: String,
    reads path: String,
    log: RequestLog,
    title: String,
    tab: String
  ) throws {
    let earlier = try log.screenPaths().count
    open(app, link)
    wait(for: [log.read(path, after: earlier)], timeout: 10)
    XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), title)
    XCTAssertTrue(app.tab(tab).isSelected, tab)
  }

  // The system delivers the link to the running app through onOpenURL.
  // `XCUIApplication.open(_:)` would relaunch the app instead.
  @MainActor
  private func open(_ app: XCUIApplication, _ link: String) {
    guard let url = URL(string: "screenr-dev://" + link) else {
      XCTFail("screenr-dev://\(link) is not a URL")
      return
    }
    XCUIDevice.shared.system.open(url)
  }
}
