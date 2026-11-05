import Foundation
import XCTest
import os

// Find a title, the search-role tab: searching, opening a result, Friends
// recommend, the filters its reads send, and each Find fixture. ScreenrKit's
// FindSearchTests and FindListsTests cover the search timing, short
// searches, filters, and wording.
final class FindTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // Alice's lists (screen/search/default) and search results
  // (actions/search/results): searching, opening a result, and Friends
  // recommend.
  @MainActor
  func testSearchesOpensAResultAndSwitchesToFriendsRecommend() throws {
    let log = RequestLog.temporary()
    let app = try openFind(FixtureLaunch(requestLog: log.file))

    // The tab opens with the search field active above the suggestions.
    let field = app.searchFields["Search movies and TV shows"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(row(app, "Winter Garden").waitForExistence(timeout: 10))
    XCTAssertTrue(
      row(app, "Winter Garden").label
        .contains(
          "Cam Rivera recommends this., Ben Ortiz wants to watch this."
        )
    )
    // The TMDB user score follows the release status. A row reads its text,
    // so the logo's label is not part of it.
    let signal = row(app, "Signal Fire").label
    XCTAssertTrue(signal.contains("Season 2 premieres Nov 4, 81%,"), signal)
    XCTAssertFalse(row(app, "Winter Garden").label.contains("%"))
    try audit(app)

    // Typing searches once it pauses, and the results replace the lists.
    field.tap()
    field.typeText("night")
    XCTAssertTrue(row(app, "Night Harbor").waitForExistence(timeout: 10))
    wait(for: [log.sent("GET /api/screenr/search?q=night")], timeout: 10)
    XCTAssertTrue(row(app, "Night Crossing").label.contains("On Netflix"))
    XCTAssertTrue(row(app, "Night Harbor").label.contains("TV show · 2018"))
    let harbor = row(app, "Night Harbor").label
    XCTAssertTrue(harbor.contains("TV show · 2018, 66%,"), harbor)
    // Too few TMDB members rated it for a score.
    XCTAssertFalse(row(app, "Night Crossing").label.contains("%"))
    XCTAssertFalse(app.buttons["Friends recommend"].exists)
    try audit(app)

    // A result opens its title, and going back keeps the search.
    row(app, "Night Crossing").tap()
    XCTAssertTrue(app.navigationBars["Night Crossing"].waitForExistence(timeout: 10))
    wait(for: [log.read("/titles/movie/101")], timeout: 10)
    XCTAssertTrue(app.tab("Find a title").isSelected)
    app.navigationBars["Night Crossing"].buttons.firstMatch.tap()
    XCTAssertTrue(row(app, "Night Harbor").waitForExistence(timeout: 10))
    XCTAssertEqual(field.value as? String, "night")

    // Closing the search shows the lists again, with the bell.
    app.buttons["Close"].tap()
    XCTAssertTrue(row(app, "Winter Garden").waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["bell"].exists)

    // Friends recommend. Alice recommends two of its titles herself, which
    // Want to watch would replace.
    app.buttons["Friends recommend"].tap()
    XCTAssertTrue(app.buttons["Friends recommend"].isSelected)
    XCTAssertTrue(app.staticTexts["Recommended by Ben Ortiz (#1)"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Recommended, Night Crossing"].exists)
    XCTAssertFalse(row(app, "Signal Fire").exists)

    // The Movies/TV filter.
    app.buttons["TV"].tap()
    XCTAssertTrue(app.buttons["Recommended, Harbor Lights"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Recommended, Night Crossing"].exists)
    app.buttons["All"].tap()

    // One tap saves a title to Want to watch.
    let save = app.buttons["Want to watch, Winter Garden"]
    XCTAssertTrue(scroll(app, to: save))
    save.tap()
    wait(for: [log.sent("POST /api/screenr/activity")], timeout: 10)
    try audit(app)
  }

  // The Find fixtures the journey above leaves out: Nora without friends
  // (screen/search/empty); Cam with his own statuses, free options, unknown
  // availability, and no saved services (screen/search/viewer-statuses); and
  // a search with no titles (actions/search/short-query).
  @MainActor
  func testRendersEveryFindFixture() throws {
    var app = try openFind(FixtureLaunch(viewer: "nora"))
    XCTAssertTrue(app.staticTexts["No suggestions yet."].waitForExistence(timeout: 10))
    app.buttons["Friends recommend"].tap()
    XCTAssertTrue(app.staticTexts["No recommendations yet."].waitForExistence(timeout: 10))
    try audit(app)

    app = try openFind(FixtureLaunch(viewer: "cam", overrides: ["actions/search/short-query"]))
    XCTAssertTrue(row(app, "Copper Coast").waitForExistence(timeout: 10))
    let myServices = app.switches["My services"].switches.firstMatch
    myServices.tap()
    XCTAssertTrue(
      app.staticTexts["1 title has unknown viewing options. Turn off My services to see it."]
        .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(row(app, "Paper Lanterns").label.contains("Free on Pluto TV, Tubi TV"))
    XCTAssertFalse(row(app, "Copper Coast").exists)
    app.buttons["Friends recommend"].tap()
    XCTAssertTrue(app.buttons["Want to watch, Paper Lanterns"].waitForExistence(timeout: 10))
    myServices.tap()
    let saved = app.buttons["Want to watch, Night Crossing"]
    XCTAssertTrue(saved.waitForExistence(timeout: 10))
    XCTAssertTrue(scroll(app, to: app.buttons["Caught up, Harbor Lights"]))
    try audit(app)

    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("night")
    XCTAssertTrue(
      app.staticTexts["No matches. Try a different title."].waitForExistence(timeout: 10)
    )
  }

  // The screen reads with the filters, so the server applies them before
  // capping each list, and changing one reads it again. After Alice finishes
  // both movies her friends recommend, Movies with finished titles hidden
  // lists none and counts them (screen/search/finished-hidden), and Show
  // finished lists them (screen/search/finished-shown).
  @MainActor
  func testReadsTheListsWithTheirFilters() throws {
    let log = RequestLog.temporary()
    let app = try openFind(FixtureLaunch(requestLog: log.file))
    wait(for: [log.read("/search?finished=hidden")], timeout: 10)
    app.buttons["Friends recommend"].tap()
    XCTAssertTrue(app.staticTexts["Recommended by Ben Ortiz (#1)"].waitForExistence(timeout: 10))

    let myServices = app.switches["My services"].switches.firstMatch
    myServices.tap()
    wait(for: [log.read("/search?services=mine&finished=hidden")], timeout: 10)
    let reads = try log.screenPaths().count
    myServices.tap()
    wait(for: [log.read("/search?finished=hidden", after: reads)], timeout: 10)

    app.buttons["Movies"].tap()
    let finished = app.staticTexts[
      "You finished all 2 movie recommendations. Turn on Show finished to see them."
    ]
    XCTAssertTrue(finished.waitForExistence(timeout: 10))
    wait(for: [log.read("/search?type=movie&finished=hidden")], timeout: 10)
    // Find's first read already had the filters.
    XCTAssertFalse(try log.screenPaths().contains("/search"))
    try audit(app)

    app.switches["Show finished"].switches.firstMatch.tap()
    XCTAssertTrue(app.buttons["Finished, Night Crossing"].waitForExistence(timeout: 10))
    XCTAssertFalse(finished.exists)
    wait(for: [log.read("/search?type=movie")], timeout: 10)
    XCTAssertTrue(scroll(app, to: app.buttons["Finished, Winter Garden"]))
    try audit(app)
  }

  // A title's initial shows only until its poster loads, so it never sits
  // beneath the poster, where an audit would measure the poster as its
  // background.
  @MainActor
  func testShowsAPosterInPlaceOfItsInitial() throws {
    var app = try openFind(FixtureLaunch())
    XCTAssertTrue(row(app, "Winter Garden").staticTexts["W"].waitForExistence(timeout: 10))
    app = try openFind(FixtureLaunch(posters: .solid))
    let title = row(app, "Winter Garden")
    XCTAssertTrue(title.waitForExistence(timeout: 10))
    XCTAssertTrue(title.staticTexts["W"].waitForNonExistence(timeout: 10))
  }

  // The audit passes over the search field's own clipped text on Find's
  // results, but still fails faint or clipped text in the app's content there.
  @MainActor
  func testAuditStillFailsFaintAndClippedTextWhileSearching() throws {
    let app = try openFind(FixtureLaunch(auditProbe: .faintClippedText))
    let field = app.searchFields["Search movies and TV shows"]
    field.tap()
    field.typeText("night")
    XCTAssertTrue(row(app, "Night Harbor").waitForExistence(timeout: 10))
    let found = OSAllocatedUnfairLock(initialState: Set<String>())
    let options = XCTExpectedFailure.Options()
    options.issueMatcher = { issue in
      let check = ["Contrast failed", "Text clipped"].first { issue.compactDescription == $0 }
      guard let check else { return false }
      found.withLock { _ = $0.insert(check) }
      return true
    }
    // Each failing check reports, rather than the first ending the test.
    continueAfterFailure = true
    try XCTExpectFailure("The probe's text is faint and cut off", options: options) {
      try audit(app)
    }
    XCTAssertEqual(found.withLock { $0 }, ["Contrast failed", "Text clipped"])
  }

  // Launches the app and selects Find a title.
  @MainActor
  private func openFind(_ fixtures: FixtureLaunch) throws -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: fixtures)
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.tab("Find a title").tap()
    XCTAssertTrue(app.navigationBars["Find a title"].waitForExistence(timeout: 10))
    return app
  }

  // Audits the list scrolled to its end. Scrolling puts the keyboard away,
  // since the audit cannot read the list through it, and at the end, rows
  // that grow with Dynamic Type stay on screen for the audit to measure.
  @MainActor
  private func audit(_ app: XCUIApplication) throws {
    app.swipeUp()
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
    try app.performShellAudit()
  }

  // A title's row, whose label starts with its name.
  @MainActor
  private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + ",")).firstMatch
  }

  // Scrolls the list until the element is on screen. Scrolling also puts the
  // keyboard away.
  @MainActor
  private func scroll(_ app: XCUIApplication, to element: XCUIElement) -> Bool {
    for _ in 0..<10 {
      if element.exists, element.isHittable { return true }
      app.swipeUp()
    }
    return element.exists && element.isHittable
  }
}

extension RequestLog {
  // Fulfilled once the app has sent a request, such as
  // `GET /api/screenr/search?q=night` or `POST /api/screenr/activity`, with
  // or without marks after it.
  func sent(_ request: String) -> XCTestExpectation {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          return try String(contentsOf: file, encoding: .utf8)
            .split(separator: "\n")
            .contains { $0 == request || $0.hasPrefix(request + " ") }
        } catch {
          return false
        }
      },
      object: nil
    )
  }
}
