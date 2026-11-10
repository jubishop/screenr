import Foundation
import XCTest

// Title pages against the fixture API: the watch status and finished date,
// the status button's chevron, Recommend with the friend line, adding to a
// full top 10, the review, the trailer, and every title fixture. Writes are
// checked in the fixture API's request log, which records each write's body,
// and trailer loads, which the fixture API records as `WEB <url>` and never
// loads.
final class TitleTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testChangesTheWatchStatusAndFinishedDate() throws {
    let log = RequestLog.temporary()
    // Alice finished Paper Lanterns on Sep 20 and ranks it #2.
    let app = launch(at: "titles/movie/102", requestLog: log)

    let status = app.buttons["watch-status"]
    XCTAssertEqual(status.label, "Finished")
    status.tap()
    let finished = app.buttons["status-finished"]
    XCTAssertTrue(finished.waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["Last finished"].firstMatch.exists)
    // The sheet is a system list; `testReadsAtTheLargestTextSize` reaches its
    // controls at the largest text size.
    try app.performSettingsAudit()
    app.buttons["Clear date"].tap()
    wait(for: [log.wrote("finished-date", #"{"date":null,"title":"movie:102"}"#)], timeout: 10)

    // Want to watch withdraws the Recommend, so a top 10 title asks first.
    status.tap()
    app.buttons["status-want_to_watch"].tap()
    XCTAssertTrue(
      app.staticTexts[
        "Switch to Want to watch? This removes your recommendation, and Paper Lanterns leaves your top 10 at #2."
      ]
      .waitForExistence(timeout: 5)
    )
    app.buttons["Switch to Want to watch"].tap()
    wait(
      for: [
        log.wrote(
          "watch-status",
          #"{"status":"want_to_watch","surface":"title","title":"movie:102"}"#
        )
      ],
      timeout: 10
    )

    status.tap()
    app.buttons["status-watching"].tap()
    wait(
      for: [log.wrote("watch-status", #"{"status":"watching","title":"movie:102"}"#)],
      timeout: 10
    )
  }

  // The status button ends in a down chevron after its label, with no status
  // and with one, so it reads as a menu of statuses rather than a one-tap
  // action like Recommend. At the largest text size the label wraps beside
  // it without clipping.
  @MainActor
  func testShowsAMenuChevronOnTheStatusButton() throws {
    // Alice has no status for Winter Garden and finished Paper Lanterns.
    let titles = [
      (path: "titles/movie/105", label: "Want to watch", icon: "plus"),
      (path: "titles/movie/102", label: "Finished", icon: "checkmark"),
    ]
    for title in titles {
      for textSize in [nil, "UICTContentSizeCategoryAccessibilityXXXL"] {
        let context = "\(title.path) at \(textSize ?? "the default text size")"
        let app = XCUIApplication()
        app.launch(with: FixtureLaunch(link: "screenr-dev://\(title.path)", textSize: textSize))
        let status = app.buttons["watch-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 10), context)
        app.scrollTo(status)
        // Dragging and holding moves the page without a fling, so the button
        // rests below the navigation bar, clear of the tab bar, where the
        // audit measures it.
        let bar = app.navigationBars.firstMatch.frame.maxY
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        start.press(
          forDuration: 0.1,
          thenDragTo: start.withOffset(CGVector(dx: 0, dy: bar + 40 - status.frame.minY)),
          withVelocity: .slow,
          thenHoldForDuration: 0.5
        )
        XCTAssertGreaterThan(status.frame.minY, bar, context)

        XCTAssertEqual(status.label, title.label, context)
        let chevron = status.images["menu-chevron"]
        XCTAssertTrue(chevron.exists, context)
        // After the label, inside the button, and larger than the label's
        // own icon.
        XCTAssertGreaterThan(
          chevron.frame.minX,
          status.staticTexts[title.label].frame.maxX,
          context
        )
        XCTAssertTrue(status.frame.contains(chevron.frame), context)
        XCTAssertGreaterThan(chevron.frame.width, status.images[title.icon].frame.width, context)
        try app.performShellAudit()
        app.terminate()
      }
    }
  }

  @MainActor
  func testRecommendsAndShowsAFriendsEntry() throws {
    let log = RequestLog.temporary()
    // Cam recommends Winter Garden, which Alice has not.
    let app = launch(at: "titles/movie/105", requestLog: log)

    app.buttons["Recommend to friends"].tap()
    wait(
      for: [
        log.wrote("activity", #"{"field":"recommended","title":"movie:105","value":true}"#)
      ],
      timeout: 10
    )

    // Night Crossing is #1 in Alice's top 10, so withdrawing asks first.
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "screenr-dev://titles/movie/101")))
    let recommended = app.buttons["Recommended"]
    XCTAssertTrue(recommended.waitForExistence(timeout: 10))
    recommended.tap()
    XCTAssertTrue(
      app.staticTexts["Remove your recommendation? Night Crossing also leaves your top 10 at #1."]
        .waitForExistence(timeout: 5)
    )
    app.buttons["Remove recommendation"].tap()
    wait(
      for: [
        log.wrote("activity", #"{"field":"recommended","title":"movie:101","value":false}"#)
      ],
      timeout: 10
    )

    // A friend's name in the friend line shows their entry below.
    app.buttons["Ben Ortiz"].firstMatch.tap()
    XCTAssertTrue(app.entry(TitleFixture.benRecommend).waitForExistence(timeout: 5))
    let entry = app.entry(TitleFixture.benRecommend)
    wait(
      for: [
        XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: entry)
      ],
      timeout: 5
    )
  }

  // Adding to a full top 10 asks which title to remove.
  @MainActor
  func testAddsToAFullTopTenByReplacingATitle() throws {
    let log = RequestLog.temporary()
    let app = launch(at: "titles/movie/105", requestLog: log)

    app.buttons["Add to top 10"].tap()
    XCTAssertTrue(
      app.staticTexts[
        "Your top 10 is full. Choose a title to remove; Winter Garden joins at #10. The title you remove stays recommended."
      ]
      .waitForExistence(timeout: 5)
    )
    XCTAssertTrue(app.buttons["replace-movie:307"].exists)
    try app.performSettingsAudit()
    app.buttons["replace-movie:102"].tap()

    wait(
      for: [
        log.wrote("top-ten", #"{"change":"add","replace":"movie:102","title":"movie:105"}"#)
      ],
      timeout: 10
    )
    XCTAssertTrue(app.buttons["Add to top 10"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testEditsAndRemovesAReview() throws {
    let log = RequestLog.temporary()
    let app = launch(at: "titles/movie/102", requestLog: log)

    app.buttons["Edit your review"].tap()
    let five = app.buttons["5 stars"]
    XCTAssertTrue(five.waitForExistence(timeout: 5))
    five.tap()
    try app.performScreenrAudit()
    app.buttons["Save review"].tap()
    wait(
      for: [
        log.wrote(
          "review",
          #"{"body":"Lovely score, slow middle.","rating":5,"spoiler":false,"title":"movie:102"}"#
        )
      ],
      timeout: 10
    )

    app.buttons["Edit your review"].tap()
    app.buttons["Remove review"].tap()
    XCTAssertTrue(
      app.staticTexts["Remove your review? Its rating and text will be erased."]
        .waitForExistence(timeout: 5)
    )
    let remove = app.buttons.matching(NSPredicate(format: "label == 'Remove'"))
    remove.element(boundBy: remove.count - 1).tap()
    wait(for: [log.wrote("remove-review", #"{"title":"movie:102"}"#)], timeout: 10)
  }

  // A failed read beneath the review form, as during a deploy, leaves the
  // form open with the typed draft, which saves once reads succeed again.
  @MainActor
  func testKeepsTheReviewFormAndDraftThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://titles/movie/101",
        requestLog: log.file,
        outage: outage
      )
    )
    XCTAssertTrue(app.buttons["watch-status"].waitForExistence(timeout: 10))
    app.buttons["Rate or review"].tap()
    let form = app.navigationBars["Rate or review"]
    let field = app.textFields["review-text"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("Tense and gorgeous.")

    // The first failed read has replaced the page beneath with the error by
    // the time the app polls again.
    outage.begin()
    let reads = try log.screenPaths().count
    wait(for: [log.screenReads(atLeast: reads + 2)], timeout: 15)
    let failure = app.staticTexts["Screenr didn't load"]
    XCTAssertTrue(failure.exists)
    XCTAssertTrue(form.exists)
    XCTAssertEqual(field.value as? String, "Tense and gorgeous.")

    outage.end()
    XCTAssertTrue(failure.waitForNonExistence(timeout: 10))
    XCTAssertTrue(form.exists)
    XCTAssertEqual(field.value as? String, "Tense and gorgeous.")
    app.buttons["Save review"].tap()
    wait(
      for: [
        log.wrote(
          "review",
          #"{"body":"Tense and gorgeous.","rating":null,"spoiler":false,"title":"movie:101"}"#
        )
      ],
      timeout: 10
    )
  }

  // A failed read beneath the confirmation that withdrawing a top 10 title's
  // Recommend asks for leaves it open to confirm once reads succeed again.
  @MainActor
  func testKeepsTheRecommendConfirmationThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://titles/movie/101",
        requestLog: log.file,
        outage: outage
      )
    )
    XCTAssertTrue(app.buttons["watch-status"].waitForExistence(timeout: 10))
    app.buttons["Recommended"].tap()
    let question = app.staticTexts[
      "Remove your recommendation? Night Crossing also leaves your top 10 at #1."
    ]
    XCTAssertTrue(question.waitForExistence(timeout: 5))

    // The first failed read has replaced the page beneath with the error by
    // the time the app polls again.
    outage.begin()
    let reads = try log.screenPaths().count
    wait(for: [log.screenReads(atLeast: reads + 2)], timeout: 15)
    let failure = app.staticTexts["Screenr didn't load"]
    XCTAssertTrue(failure.exists)
    XCTAssertTrue(question.exists)

    outage.end()
    XCTAssertTrue(failure.waitForNonExistence(timeout: 10))
    XCTAssertTrue(question.exists)
    app.buttons["Remove recommendation"].tap()
    wait(
      for: [
        log.wrote("activity", #"{"field":"recommended","title":"movie:101","value":false}"#)
      ],
      timeout: 10
    )
  }

  // Nothing loads from YouTube until Play trailer, which opens the player and
  // asks for the embed.
  @MainActor
  func testPlaysTheTrailerOnlyAfterPlay() throws {
    let log = RequestLog.temporary()
    let app = launch(at: "titles/movie/101", requestLog: log)
    let play = app.buttons["Play trailer"]
    app.scrollTo(play)
    XCTAssertTrue(app.descendants(matching: .any)["Watch on YouTube"].firstMatch.exists)
    XCTAssertFalse(app.otherElements["trailer-player"].exists)
    XCTAssertFalse(app.webViews.firstMatch.exists)
    XCTAssertFalse(try log.loggedLines().contains { $0.hasPrefix("WEB ") })

    play.tap()

    let player = app.otherElements["trailer-player"]
    XCTAssertTrue(player.waitForExistence(timeout: 5))
    XCTAssertTrue(player.webViews.firstMatch.exists)
    XCTAssertFalse(play.exists)
    let embed = "WEB https://www.youtube.com/embed/nightCross1?autoplay=1&playsinline=1"
    wait(
      for: [
        XCTNSPredicateExpectation(
          predicate: NSPredicate { _, _ in
            do {
              return try log.loggedLines().filter { $0.hasPrefix("WEB ") } == [embed]
            } catch {
              return false
            }
          },
          object: nil
        )
      ],
      timeout: 10
    )
  }

  // At the largest accessibility text size, nothing on the page clips or
  // loses contrast, and every choice in the status and replacement sheets
  // can be reached.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://titles/movie/101",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(app.buttons["watch-status"].waitForExistence(timeout: 10))
    try app.performShellAudit()

    // Alice finished Paper Lanterns on a date.
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "screenr-dev://titles/movie/102")))
    XCTAssertTrue(app.staticTexts["Paper Lanterns"].firstMatch.waitForExistence(timeout: 10))
    app.scrollTo(app.buttons["watch-status"])
    app.buttons["watch-status"].tap()
    XCTAssertTrue(app.buttons["status-finished"].waitForExistence(timeout: 5))
    app.scrollTo(app.buttons["Clear date"])
    app.buttons["Close"].tap()

    // Alice's top 10 is full.
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: "screenr-dev://titles/movie/105")))
    XCTAssertTrue(app.staticTexts["Winter Garden"].firstMatch.waitForExistence(timeout: 10))
    app.scrollTo(app.buttons["Add to top 10"])
    app.buttons["Add to top 10"].tap()
    XCTAssertTrue(app.buttons["replace-movie:101"].waitForExistence(timeout: 5))
    app.scrollTo(app.buttons["replace-movie:307"])
  }

  // Each title fixture loads and shows its title, its release status and
  // TMDB user score, its linked reply, or that the title was not found,
  // without an error.
  @MainActor
  func testRendersEveryTitleFixture() throws {
    let directory = FixtureLaunch.directory.appending(path: "screen/title")
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path())
      .filter { $0.hasSuffix(".json") }
      .map { String($0.dropLast(".json".count)) }
      .sorted()
    XCTAssertEqual(
      names,
      [
        "demo", "earlier", "finished-review", "full-top-ten", "in-theaters", "linked-reply",
        "movie",
        "not-found", "premiere", "stale-availability", "stopped", "theatrical-release", "tv",
        "unknown-availability",
      ]
    )
    // The status and score sit atop Where to watch, apart from its services.
    let releases = [
      "in-theaters": "In theaters · Digital Nov 20",
      "premiere": "Premieres Dec 1 on Hulu",
      "theatrical-release": "In theaters Dec 18 · Digital Feb 2, 2027",
    ]
    let scores = ["in-theaters": "73%", "premiere": "81%"]
    for name in names {
      let fixture = try TitleFixtureFile(directory.appending(path: "\(name).json"))
      let app = XCUIApplication()
      app.launch(
        with: FixtureLaunch(
          viewer: fixture.viewer,
          overrides: ["screen/title/\(name)"],
          link: "screenr-dev://\(fixture.path.dropFirst())"
        )
      )
      let expected: XCUIElement =
        if let title = fixture.title {
          app.staticTexts[title].firstMatch
        } else {
          app.staticTexts["Not found"]
        }
      XCTAssertTrue(expected.waitForExistence(timeout: 10), "screen/title/\(name)")
      XCTAssertTrue(
        fixture.title == nil || app.staticTexts["Where to watch"].exists,
        "screen/title/\(name)"
      )
      if let release = releases[name] {
        XCTAssertTrue(app.staticTexts[release].exists, "screen/title/\(name)")
      }
      XCTAssertEqual(app.images["TMDB"].exists, scores[name] != nil, "screen/title/\(name)")
      if let score = scores[name] {
        XCTAssertTrue(app.staticTexts[score].exists, "screen/title/\(name)")
      }
      if let reply = fixture.targetReply {
        XCTAssertTrue(app.comment(reply).waitForExistence(timeout: 10), "screen/title/\(name)")
      }
      app.terminate()
    }
  }

  @MainActor
  private func launch(at path: String, requestLog log: RequestLog) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://\(path)", requestLog: log.file))
    XCTAssertTrue(app.buttons["watch-status"].waitForExistence(timeout: 10))
    return app
  }
}

// Fixture entries the title tests use.
enum TitleFixture {
  // Ben's Recommend of Night Crossing, the friend line's first name.
  static let benRecommend = FeedFixture.benRecommend
}

// The parts of a title fixture a test needs to launch it and know what shows.
private struct TitleFixtureFile {
  let viewer: String
  let path: String
  // The title's name, or nil when the title was not found.
  let title: String?
  // The reply a permalink fixture links to, which the feed scrolls to.
  let targetReply: String?

  init(_ file: URL) throws {
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    let request = json?["request"] as? [String: Any]
    let query = request?["query"] as? [String: String]
    let body = (json?["response"] as? [String: Any])?["body"] as? [String: Any]
    viewer = json?["viewer"] as? String ?? "alice"
    path = query?["path"] ?? "/"
    title = (body?["title"] as? [String: Any])?["name"] as? String
    targetReply = (body?["target"] as? [String: Any])?["reply"] as? String
  }
}
