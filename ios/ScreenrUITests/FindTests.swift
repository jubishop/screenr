import Foundation
import XCTest

// Find a title, the search-role tab: searching, opening a result, Friends
// recommend, and each Find fixture. ScreenrKit's FindSearchTests and
// FindListsTests cover the search timing, short searches, filters, and
// wording.
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
    try audit(app)

    // Typing searches once it pauses, and the results replace the lists.
    field.tap()
    field.typeText("night")
    XCTAssertTrue(row(app, "Night Harbor").waitForExistence(timeout: 10))
    wait(for: [log.sent("GET /api/screenr/search?q=night")], timeout: 10)
    XCTAssertTrue(row(app, "Night Crossing").label.contains("On Netflix (saved)"))
    XCTAssertTrue(row(app, "Night Harbor").label.contains("TV show · 2018"))
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
    XCTAssertEqual(saved.value as? String, "Saved")
    XCTAssertTrue(scroll(app, to: app.buttons["Caught up, Harbor Lights"]))
    try audit(app)

    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("night")
    XCTAssertTrue(
      app.staticTexts["No matches. Try a different title."].waitForExistence(timeout: 10)
    )
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

  // A title's row, which VoiceOver reads starting with its name.
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
