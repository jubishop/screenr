import Foundation
import XCTest

// The share extension, from the app's own share sheet: iOS lists Screenr Dev
// there for a title's link. The extension answers from the fixtures the app
// launched with, which it keeps in the app group for the extension, and
// writes to the same request log.
final class ShareExtensionTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // The extension finds the shared title, shows it with the friends who
  // recommend it or want to watch it, and switches Alice's Recommend of it,
  // which is in her top 10, to Want to watch once she confirms, as the
  // title page does. Then it closes.
  @MainActor
  func testSavesASharedTitleToWantToWatch() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://titles/movie/101", requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Night Crossing"].waitForExistence(timeout: 10))

    app.buttons["Share"].firstMatch.tap()
    let screenr = app.cells["Screenr Dev"]
    XCTAssertTrue(screenr.waitForExistence(timeout: 20))
    screenr.tap()

    // The extension's view, which the app's hierarchy holds while it shows.
    let sheet = app.navigationBars["Screenr"]
    XCTAssertTrue(sheet.waitForExistence(timeout: 30))
    let friends = app.collectionViews.staticTexts[
      "Recommended by Ben Ortiz (#1) · Cam Rivera wants to watch"
    ]
    XCTAssertTrue(friends.waitForExistence(timeout: 20))
    wait(
      for: [
        log.logged(where: {
          $0.hasPrefix("GET /api/screenr/resolve-title?")
            && $0.contains("screenr.club%2Ftitles%2Fmovie%2F101")
        })
      ],
      timeout: 10
    )
    try app.performScreenrAudit()

    app.collectionViews.buttons["Want to watch"].tap()
    let confirm = app.buttons["Switch to Want to watch"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 10))
    confirm.tap()
    wait(
      for: [
        log.logged(
          #"POST /api/screenr/watch-status {"status":"want_to_watch","surface":"title","title":"movie:101"}"#
        )
      ],
      timeout: 10
    )
    sheet.buttons["Close"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.navigationBars["Night Crossing"].exists)
  }
}
