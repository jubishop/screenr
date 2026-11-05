import Foundation
import XCTest

// Watch together against the fixture API: opened from a friend's profile,
// filtered by kind, switched to In theaters, and every Watch together
// fixture.
final class WatchTogetherTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testComparesWantToWatchWithAFriend() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/ben", requestLog: log.file))
    let open = app.buttons["Watch together"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()

    XCTAssertTrue(app.navigationBars["Watch together"].waitForExistence(timeout: 10))
    wait(for: [log.read("/watch-together?with=ben")], timeout: 10)
    XCTAssertTrue(app.staticTexts["Ready to watch"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["2 shared titles"].exists)
    // At home is the default.
    XCTAssertTrue(app.buttons["At home"].isSelected)
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.exists)
    XCTAssertTrue(orchard.label.contains("In theaters · Digital Nov 20, 73%,"), orchard.label)
    XCTAssertTrue(orchard.label.contains("On Hulu"))
    XCTAssertTrue(orchard.label.contains("Included in either person’s saved services"))
    try app.performShellAudit()

    app.buttons["TV"].tap()
    XCTAssertTrue(app.staticTexts["No shared TV shows yet."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["0 shared titles"].exists)
    XCTAssertFalse(orchard.exists)
    app.buttons["All"].tap()

    XCTAssertTrue(orchard.waitForExistence(timeout: 5))
    orchard.tap()
    wait(for: [log.read("/titles/movie/103")], timeout: 10)
  }

  // In theaters takes Watch together's place with the shared movies in US
  // theaters now, without the filter, services, or viewing options. Its
  // movies keep Watch together's surface, and Back leaves the comparison.
  @MainActor
  func testSwitchesToInTheaters() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(link: "screenr-dev://watch-together?with=ben", requestLog: log.file)
    )
    XCTAssertTrue(app.staticTexts["2 shared titles"].waitForExistence(timeout: 10))

    app.buttons["In theaters"].tap()
    wait(for: [log.read("/watch-together?with=ben&mode=theaters")], timeout: 10)
    XCTAssertTrue(
      app.staticTexts[
        "Movies you both want to watch that are in US theaters now, newest shared first."
      ]
      .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(app.buttons["In theaters"].isSelected)
    XCTAssertTrue(app.navigationBars["Watch together"].exists)
    XCTAssertTrue(app.staticTexts["Alice Park & Ben Ortiz"].exists)
    XCTAssertTrue(app.staticTexts["1 shared movie in theaters"].exists)
    XCTAssertTrue(app.staticTexts["In theaters now"].exists)
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.exists)
    XCTAssertTrue(orchard.label.contains("In theaters · Digital Nov 20, 73%"), orchard.label)
    XCTAssertFalse(orchard.label.contains("On Hulu"), orchard.label)
    XCTAssertTrue(app.staticTexts["Availability unknown"].exists)
    XCTAssertTrue(app.buttons(starting: "Glass Meridian").exists)
    XCTAssertFalse(app.buttons["TV"].exists)
    XCTAssertFalse(
      app.buttons["Save your streaming services to see what you can watch right now."].exists
    )
    try app.performShellAudit()

    orchard.tap()
    XCTAssertTrue(app.navigationBars["The Quiet Orchard"].waitForExistence(timeout: 10))
    wait(for: [log.read("/titles/movie/103")], timeout: 10)
    app.navigationBars["The Quiet Orchard"].buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.staticTexts["1 shared movie in theaters"].waitForExistence(timeout: 10))
    app.navigationBars["Watch together"].buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.navigationBars["Friends"].waitForExistence(timeout: 10))
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  // The audit scrolls the list to reach each title.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://watch-together?with=ben",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(app.staticTexts["Alice Park & Ben Ortiz"].waitForExistence(timeout: 10))
    try app.performShellAudit()
  }

  @MainActor
  func testReadsInTheatersAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://watch-together?with=ben&mode=theaters",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(
      app.staticTexts[
        "Movies you both want to watch that are in US theaters now, newest shared first."
      ]
      .waitForExistence(timeout: 10)
    )
    try app.performShellAudit()
  }

  // Each fixture shows its sections, that nothing is shared yet or in
  // theaters, or why the comparison needs a friend, and the mode its link
  // names.
  @MainActor
  func testRendersEveryWatchTogetherFixture() throws {
    let names = try FixtureNames.list("screen/watch-together")
    XCTAssertEqual(
      names,
      [
        "default", "missing-friend", "nothing-shared", "theaters", "theaters-nothing-shared",
        "unmatched",
      ]
    )
    let expected = [
      "default": "Ready to watch",
      "missing-friend": "Choose one friend from their profile.",
      "nothing-shared": "No shared titles yet.",
      "theaters": "1 shared movie in theaters",
      "theaters-nothing-shared": "No shared movies in theaters.",
      "unmatched": "Not on your services",
    ]
    // They are all Alice's, so one launch opens each fixture's link. One
    // that shares another's link, as `unmatched` shares `default`'s, answers
    // only as an override, in a launch of its own.
    let shared = ["unmatched"]
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch())
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    for name in names where !shared.contains(name) {
      try checkFixture(app, name, shows: try XCTUnwrap(expected[name]))
    }
    app.terminate()
    for name in shared {
      let overridden = XCUIApplication()
      overridden.launch(with: FixtureLaunch(overrides: ["screen/watch-together/\(name)"]))
      XCTAssertTrue(overridden.tabBars.firstMatch.waitForExistence(timeout: 10))
      try checkFixture(overridden, name, shows: try XCTUnwrap(expected[name]))
      overridden.terminate()
    }
  }

  // Opens the fixture's link and checks that it shows `text` in the mode the
  // link names.
  @MainActor
  private func checkFixture(_ app: XCUIApplication, _ name: String, shows text: String) throws {
    let fixture = try ScreenFixtureFile("screen/watch-together/\(name)")
    XCTAssertEqual(fixture.viewer, "alice", fixture.name)
    try app.openFixture(fixture)
    XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), fixture.name)
    XCTAssertTrue(app.navigationBars["Watch together"].exists, fixture.name)
    if fixture.status == 200 {
      let mode = fixture.body["mode"] == nil ? "At home" : "In theaters"
      XCTAssertTrue(app.buttons[mode].isSelected, fixture.name)
    }
  }
}
