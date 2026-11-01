import Foundation
import XCTest

// A profile's Want to watch page against the fixture API: the viewer's own
// page from the You tab, filtered by kind, a friend's page in both modes, and
// every Want to watch fixture.
final class WantToWatchTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testOpensTheViewersOwnPageFromTheYouTab() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    app.tab("You").tap()
    let open = app.buttons["want-to-watch"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()

    XCTAssertTrue(app.navigationBars["Want to watch"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("You").isSelected)
    wait(for: [log.read("/people/alice/want-to-watch")], timeout: 10)
    XCTAssertTrue(app.staticTexts["Ready to watch"].waitForExistence(timeout: 10))
    // At home is the default.
    XCTAssertTrue(app.buttons["At home"].isSelected)
    XCTAssertFalse(app.buttons["In theaters"].isSelected)
    XCTAssertTrue(
      app.staticTexts[
        "Titles you want to watch that are on your services or free, newest first."
      ]
      .exists
    )
    XCTAssertTrue(app.staticTexts["1 title to watch now"].exists)
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.exists)
    // The TMDB user score follows the release status.
    XCTAssertTrue(orchard.label.contains("In theaters · Digital Nov 20, 73%,"), orchard.label)
    XCTAssertTrue(app.staticTexts["Availability unknown"].exists)
    XCTAssertTrue(app.buttons(starting: "Glass Meridian").exists)
    XCTAssertFalse(
      app.buttons["Save your streaming services to see what you can watch right now."].exists
    )
    try app.performShellAudit()

    app.buttons["TV"].tap()
    XCTAssertTrue(app.staticTexts["No TV shows to watch right now."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["0 titles to watch now"].exists)
    XCTAssertFalse(orchard.exists)
    XCTAssertFalse(app.staticTexts["Availability unknown"].exists)
    app.buttons["All"].tap()

    XCTAssertTrue(orchard.waitForExistence(timeout: 5))
    orchard.tap()
    wait(for: [log.read("/titles/movie/103")], timeout: 10)
  }

  // A friend's page names them, and the viewer's own services decide.
  @MainActor
  func testOpensAFriendsPage() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/ben", requestLog: log.file))
    let open = app.buttons["want-to-watch"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()

    XCTAssertTrue(app.navigationBars["Want to watch"].waitForExistence(timeout: 10))
    wait(for: [log.read("/people/ben/want-to-watch")], timeout: 10)
    XCTAssertTrue(
      app.staticTexts[
        "Titles Ben Ortiz wants to watch that are on your services or free, newest first."
      ]
      .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(app.staticTexts["2 titles to watch now"].exists)
    XCTAssertTrue(app.buttons(starting: "The Quiet Orchard").exists)
    let garden = app.buttons(starting: "Winter Garden")
    XCTAssertTrue(garden.exists)
    XCTAssertTrue(app.buttons(starting: "The Quiet Orchard").label.contains("In theaters"))
    XCTAssertTrue(garden.label.contains("Included in your saved services"))
    try app.performShellAudit()

    garden.tap()
    XCTAssertTrue(app.navigationBars["Winter Garden"].waitForExistence(timeout: 10))
    wait(for: [log.read("/titles/movie/105")], timeout: 10)
  }

  // In theaters takes the page's place with the friend's movies in US
  // theaters now, without the filter, services, or viewing options, and At
  // home comes back the same way. Back leaves the page from either mode.
  @MainActor
  func testSwitchesAFriendsPageToInTheatersAndBack() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/ben", requestLog: log.file))
    let open = app.buttons["want-to-watch"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()
    XCTAssertTrue(app.staticTexts["2 titles to watch now"].waitForExistence(timeout: 10))

    app.buttons["In theaters"].tap()
    wait(for: [log.read("/people/ben/want-to-watch?mode=theaters")], timeout: 10)
    XCTAssertTrue(
      app.staticTexts[
        "Movies Ben Ortiz wants to watch that are in US theaters now, newest first."
      ]
      .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(app.buttons["In theaters"].isSelected)
    XCTAssertTrue(app.navigationBars["Want to watch"].exists)
    XCTAssertTrue(app.staticTexts["1 movie in theaters"].exists)
    XCTAssertTrue(app.staticTexts["In theaters now"].exists)
    XCTAssertTrue(
      app.staticTexts["Based on US release dates. Check local theaters for showtimes."].exists
    )
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.exists)
    XCTAssertTrue(orchard.label.contains("In theaters · Digital Nov 20, 73%"), orchard.label)
    XCTAssertFalse(orchard.label.contains("On Hulu"), orchard.label)
    XCTAssertTrue(app.staticTexts["Availability unknown"].exists)
    XCTAssertTrue(app.buttons(starting: "Glass Meridian").exists)
    // His movie that left theaters long ago is not listed.
    XCTAssertFalse(app.buttons(starting: "Winter Garden").exists)
    XCTAssertFalse(app.buttons["TV"].exists)
    try app.performShellAudit()

    let reads = try log.screenPaths().count
    app.buttons["At home"].tap()
    wait(for: [log.read("/people/ben/want-to-watch", after: reads)], timeout: 10)
    XCTAssertTrue(app.staticTexts["2 titles to watch now"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["At home"].isSelected)

    app.buttons["In theaters"].tap()
    XCTAssertTrue(app.staticTexts["1 movie in theaters"].waitForExistence(timeout: 10))
    app.navigationBars["Want to watch"].buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.navigationBars["Ben Ortiz"].waitForExistence(timeout: 10))
  }

  // A link with the mode opens In theaters, in You once the viewer is known,
  // and a movie there opens its title page.
  @MainActor
  func testOpensAMovieFromInTheaters() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://people/alice/want-to-watch?mode=theaters",
        requestLog: log.file
      )
    )
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("You").isSelected)
    XCTAssertTrue(app.buttons["In theaters"].isSelected)
    XCTAssertTrue(
      app.staticTexts["Movies you want to watch that are in US theaters now, newest first."]
        .exists
    )

    orchard.tap()
    XCTAssertTrue(app.navigationBars["The Quiet Orchard"].waitForExistence(timeout: 10))
    wait(for: [log.read("/titles/movie/103")], timeout: 10)
  }

  // Someone who is not a friend has no link to their page.
  @MainActor
  func testLeavesTheLinkOffProfilesThatHideActivity() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/erin"))
    XCTAssertTrue(app.buttons["Send friend request"].waitForExistence(timeout: 10))

    XCTAssertFalse(app.buttons["want-to-watch"].exists)
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  // The audit scrolls the list to reach each title.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://people/alice/want-to-watch",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(
      app.staticTexts[
        "Titles you want to watch that are on your services or free, newest first."
      ]
      .waitForExistence(timeout: 10)
    )
    try app.performShellAudit()
  }

  @MainActor
  func testReadsInTheatersAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://people/alice/want-to-watch?mode=theaters",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(
      app.staticTexts["Movies you want to watch that are in US theaters now, newest first."]
        .waitForExistence(timeout: 10)
    )
    try app.performShellAudit()
  }

  // Each fixture shows its titles, why nothing is ready to watch or in
  // theaters, or that the page is not found, with the services prompt for a
  // viewer who has saved none, and the mode its link names.
  @MainActor
  func testRendersEveryWantToWatchFixture() throws {
    let names = try FixtureNames.list("screen/want-to-watch")
    XCTAssertEqual(
      names,
      [
        "empty", "friend", "not-friends", "nothing-to-watch", "own", "theaters-empty",
        "theaters-friend", "theaters-nothing", "theaters-own",
      ]
    )
    let expected = [
      "empty": "No Want to watch titles yet.",
      "friend": "Ready to watch",
      "not-friends": "Want to watch not found.",
      "nothing-to-watch": "Nothing to watch right now.",
      "own": "Availability unknown",
      "theaters-empty":
        "When you add movies to Want to watch, the ones in US theaters now appear here.",
      "theaters-friend":
        "Movies Ben Ortiz wants to watch that are in US theaters now, newest first.",
      "theaters-nothing": "Nothing in theaters right now.",
      "theaters-own": "Movies you want to watch that are in US theaters now, newest first.",
    ]
    let fixtures = try names.map { try ScreenFixtureFile("screen/want-to-watch/\($0)") }
    // One launch for each viewer opens each of their fixtures' links.
    for viewer in Set(fixtures.map(\.viewer)).sorted() {
      let app = XCUIApplication()
      app.launch(with: FixtureLaunch(viewer: viewer))
      XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10), viewer)
      for fixture in fixtures where fixture.viewer == viewer {
        try app.openFixture(fixture)
        let label = fixture.name
        let text = try XCTUnwrap(expected[URL(filePath: label).lastPathComponent], label)
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), label)
        XCTAssertTrue(app.navigationBars["Want to watch"].exists, label)
        let prompt = app.buttons[
          "Save your streaming services to see what you can watch right now."
        ]
        XCTAssertEqual(
          prompt.exists,
          fixture.body["viewerHasServices"] as? Bool == false,
          label
        )
        // Only the viewer's own page without titles offers Find a title,
        // in the list rather than the tab bar.
        XCTAssertEqual(
          app.collectionViews.buttons["Find a title"].exists,
          label.hasSuffix("empty"),
          label
        )
        // A page that loads shows its link's mode.
        if fixture.status == 200 {
          let mode = fixture.body["mode"] == nil ? "At home" : "In theaters"
          XCTAssertTrue(app.buttons[mode].isSelected, label)
        }
      }
      app.terminate()
    }
  }
}
