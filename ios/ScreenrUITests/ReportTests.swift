import Foundation
import XCTest

// Reporting another member's reply, review, or profile against the fixture
// API: the form, the report it sends, the offer to block the author once the
// form closes, and a failure that keeps the form. The viewer's own content
// offers no Report. Writes are checked in the fixture API's request log.
final class ReportTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  private let after =
    "You won’t see each other’s profiles, posts, or comments, and neither of you can send a "
    + "friend request until you unblock them."

  // Alice reports Ben's reply on her post with a reason and a note, then
  // declines to block him.
  @MainActor
  func testReportsAReplyWithANote() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.entry(FeedFixture.benRecommend).waitForExistence(timeout: 10))
    let post = app.entry(FeedFixture.alicePost)
    app.scrollTo(post)
    XCTAssertFalse(post.buttons["Report post"].exists)
    let reply = app.comment("8")
    app.scrollTo(reply)
    reply.buttons["Report"].tap()

    let form = app.navigationBars["Report this comment"]
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Why are you reporting it?"].exists)
    XCTAssertTrue(
      app.staticTexts[
        "Screenr’s owner reviews every report within 24 hours. You won’t see this comment anymore."
      ]
      .exists
    )
    let report = form.buttons["Report"]
    XCTAssertFalse(report.isEnabled)
    app.buttons["Spam"].tap()
    XCTAssertTrue(report.isEnabled)
    try app.performScreenrAudit()
    let note = app.textFields["Add details (optional)"]
    note.tap()
    note.typeText("He posts this link everywhere.")
    report.tap()

    wait(
      for: [
        log.wrote(
          "report",
          #"{"item":"\#(FeedFixture.alicePost)","note":"He posts this link everywhere.","reason":"spam","reply":"8"}"#
        )
      ],
      timeout: 10
    )
    XCTAssertTrue(form.waitForNonExistence(timeout: 10))
    let thanks = app.alerts["Thanks for reporting"]
    XCTAssertTrue(thanks.waitForExistence(timeout: 10))
    XCTAssertTrue(
      thanks.text("Screenr’s owner will review it. Block Ben Ortiz too? " + after).exists
    )
    thanks.buttons["Not Now"].tap()
    XCTAssertTrue(thanks.waitForNonExistence(timeout: 10))
    XCTAssertFalse(
      try log.loggedLines().contains { $0.hasPrefix("POST /api/screenr/relationship") }
    )
  }

  // On a title page, Alice's own comment and reply offer no Report, Ben's
  // reply does, and she reports Ben's review, then blocks him.
  @MainActor
  func testReportsAReviewAndBlocksItsAuthor() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://titles/tv/201", requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Harbor Lights"].waitForExistence(timeout: 10))
    let own = app.entry(FeedFixture.aliceComment)
    app.scrollTo(own)
    XCTAssertFalse(own.buttons["Report comment"].exists)
    own.buttons["View 2 replies"].tap()
    let ownReply = app.comment("4")
    app.scrollTo(ownReply)
    XCTAssertFalse(ownReply.buttons["Report"].exists)
    XCTAssertTrue(app.comment("3").buttons["Report"].exists)

    let review = app.entry(FeedFixture.benCard)
    app.scrollTo(review)
    review.buttons["Report review"].tap()
    let form = app.navigationBars["Report this review"]
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts[
        "Screenr’s owner reviews every report within 24 hours. You won’t see this review anymore."
      ]
      .exists
    )
    app.buttons["Harassment or bullying"].tap()
    form.buttons["Report"].tap()

    wait(
      for: [log.wrote("report", #"{"item":"\#(FeedFixture.benCard)","reason":"harassment"}"#)],
      timeout: 10
    )
    let thanks = app.alerts["Thanks for reporting"]
    XCTAssertTrue(thanks.waitForExistence(timeout: 10))
    thanks.buttons["Block Ben Ortiz"].tap()
    wait(for: [log.wrote("relationship", #"{"action":"block","target":"user-ben"}"#)], timeout: 10)
    XCTAssertTrue(app.navigationBars["Harbor Lights"].exists)
  }

  // Report waits in a profile's More actions, after Block. Blocking from the
  // offer then leaves the profile, as Block there does.
  @MainActor
  func testReportsAProfileAndBlocksThem() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/erin", requestLog: log.file))
    XCTAssertTrue(app.buttons["Send friend request"].waitForExistence(timeout: 10))
    app.buttons["More actions for Erin Walsh"].tap()
    let block = app.buttons["Block"]
    let menuReport = app.buttons["Report"]
    XCTAssertTrue(menuReport.waitForExistence(timeout: 5))
    XCTAssertLessThan(block.frame.minY, menuReport.frame.minY)
    menuReport.tap()

    let form = app.navigationBars["Report Erin Walsh’s profile"]
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts["Screenr’s owner reviews every report within 24 hours."].exists
    )
    app.buttons["Sexual content"].tap()
    form.buttons["Report"].tap()

    wait(for: [log.wrote("report", #"{"person":"user-erin","reason":"sexual"}"#)], timeout: 10)
    let thanks = app.alerts["Thanks for reporting"]
    XCTAssertTrue(thanks.waitForExistence(timeout: 10))
    XCTAssertTrue(
      thanks.text("Screenr’s owner will review it. Block Erin Walsh too? " + after).exists
    )
    thanks.buttons["Block Erin Walsh"].tap()

    wait(for: [log.wrote("relationship", #"{"action":"block","target":"user-erin"}"#)], timeout: 10)
    XCTAssertTrue(app.navigationBars["Friends"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["You blocked Erin Walsh."].waitForExistence(timeout: 10))
  }

  // A report the server refuses keeps the form open with its reason.
  @MainActor
  func testKeepsTheFormWithTheServersReason() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(overrides: ["actions/report/not-reportable"], requestLog: log.file)
    )
    XCTAssertTrue(app.entry(FeedFixture.benRecommend).waitForExistence(timeout: 10))
    let review = app.entry(FeedFixture.benCard)
    app.scrollTo(review)
    review.buttons["Report review"].tap()
    let form = app.navigationBars["Report this review"]
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    app.buttons["Spam"].tap()
    form.buttons["Report"].tap()

    let failure = app.staticTexts["Only posts, reviews, comments, and profiles can be reported."]
    XCTAssertTrue(failure.waitForExistence(timeout: 10))
    XCTAssertTrue(form.exists)
    XCTAssertTrue(form.buttons["Report"].isEnabled)
    try app.performScreenrAudit()
    form.buttons["Cancel"].tap()
    XCTAssertTrue(form.waitForNonExistence(timeout: 10))
    XCTAssertFalse(app.alerts["Thanks for reporting"].waitForExistence(timeout: 2))
    XCTAssertEqual(
      try log.loggedLines().filter { $0.hasPrefix("POST") },
      [#"POST /api/screenr/report {"item":"\#(FeedFixture.benCard)","reason":"spam"}"#]
    )
  }
}

extension XCUIElement {
  // Text by its whole label, which a subscript limits to 128 characters.
  fileprivate func text(_ label: String) -> XCUIElement {
    staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
  }
}
