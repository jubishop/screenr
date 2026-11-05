import Foundation
import XCTest

// The Circle feed and its conversations against the fixture API: reading
// entries and discussions, posting, reacting, revealing spoilers, removing a
// comment, permalinks, and every feed fixture. Writes are checked in the
// fixture API's request log, which records each write's body. Entries with
// the same time sort by ID, so tests that reach Alice's later entries start
// from Hana's permalink to Alice's post, part way down, to scroll less.
final class FeedTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testReadsEntriesAndTheirDiscussions() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch())

    let recommend = app.entry(FeedFixture.benRecommend)
    XCTAssertTrue(recommend.waitForExistence(timeout: 10))
    // The author's link names what they did and when.
    XCTAssertTrue(recommend.buttons(starting: "Ben Ortiz, recommends").exists)
    XCTAssertTrue(recommend.buttons(starting: "Night Crossing").exists)
    XCTAssertTrue(recommend.buttons(starting: "Night Crossing").label.contains("Movie · 2024"))
    XCTAssertTrue(recommend.buttons["Like"].exists)
    XCTAssertTrue(recommend.buttons["Love"].exists)
    XCTAssertTrue(recommend.buttons["Recommended"].exists)
    XCTAssertTrue(recommend.staticTexts["1 reply"].exists)
    XCTAssertTrue(recommend.staticTexts["Comment unavailable"].exists)
    XCTAssertFalse(app.comment("2").exists)
    recommend.buttons["View 1 reply"].tap()
    XCTAssertTrue(app.comment("2").staticTexts["That last scene stayed with me."].exists)
    XCTAssertTrue(recommend.buttons["Hide 1 reply"].exists)
    try app.performShellAudit()

    let deleted = app.entry(FeedFixture.camPost)
    app.scrollTo(deleted)
    XCTAssertTrue(deleted.staticTexts["Post removed"].exists)
    XCTAssertTrue(deleted.staticTexts["Which book?"].exists)
    // Only Ben's reply has reactions; the removed post has none.
    XCTAssertEqual(deleted.buttons.matching(NSPredicate(format: "label == 'React'")).count, 1)
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(textSize: "UICTContentSizeCategoryAccessibilityXXXL"))
    XCTAssertTrue(app.entry(FeedFixture.benRecommend).waitForExistence(timeout: 10))
    try app.performShellAudit()
  }

  // A paged feed reads its newest page, and Show older reads the page before
  // it, whose entries show at once, as later polls keep that longer window.
  @MainActor
  func testShowsOlderEntries() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        viewer: "nora",
        overrides: ["screen/feed/newest-page", "screen/feed/older-page"],
        requestLog: log.file
      )
    )
    XCTAssertTrue(app.staticTexts["Post 51"].waitForExistence(timeout: 10))
    let older = app.buttons["Show older"]
    app.scrollTo(older)
    XCTAssertFalse(app.staticTexts["Post 1"].exists)
    try app.performShellAudit()
    older.tap()

    let first = app.staticTexts["Post 1"]
    app.scrollTo(first)
    XCTAssertFalse(app.buttons["Show older"].exists)
    XCTAssertFalse(
      app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New activity'")).firstMatch.exists
    )
    let window = "2026-10-13T12%3A00%3A00.000Z"
    wait(
      for: [
        log.expectation { _ in
          do {
            let sent = try log.sentScreenPaths()
            return sent.first == "/?before=now" && sent.contains("/?before=\(window)")
              && sent.last == "/?since=\(window)"
          } catch {
            return false
          }
        }
      ],
      timeout: 15
    )
    XCTAssertTrue(first.exists)
  }

  @MainActor
  func testPostsRepliesAndComments() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    let entry = app.entry(FeedFixture.benRecommend)
    XCTAssertTrue(entry.waitForExistence(timeout: 10))

    // A reply beneath Ben's reply.
    entry.buttons["View 1 reply"].tap()
    app.comment("2").buttons["Reply"].tap()
    XCTAssertTrue(entry.staticTexts["Replying to @ben"].waitForExistence(timeout: 5))
    let reply = app.composerField("Your nested reply")
    XCTAssertTrue(reply.waitForExistence(timeout: 5))
    reply.typeText("Adding it to my list.")
    try app.performShellAudit()
    app.buttons["Post reply"].tap()
    wait(
      for: [
        log.wrote(
          "comment",
          #"{"body":"Adding it to my list.","conversation":"\#(FeedFixture.benRecommend)","replyTo":"2","spoiler":false}"#
        )
      ],
      timeout: 10
    )
    // The posted draft clears, so there is nothing to post until more text.
    XCTAssertFalse(app.buttons["Post reply"].isEnabled)
    entry.buttons["Cancel"].tap()

    // A spoiler comment on the entry itself.
    entry.buttons["Comment"].tap()
    let comment = app.composerField("Add your reply")
    XCTAssertTrue(comment.waitForExistence(timeout: 5))
    comment.typeText("Saw it twice.")
    // The row holds the switch itself, which takes the tap.
    let spoiler = entry.switches["Contains spoilers"]
    spoiler.switches.firstMatch.tap()
    XCTAssertEqual(spoiler.value as? String, "1")
    app.buttons["Post reply"].tap()
    wait(
      for: [
        log.wrote(
          "comment",
          #"{"body":"Saw it twice.","conversation":"\#(FeedFixture.benRecommend)","spoiler":true}"#
        )
      ],
      timeout: 10
    )
  }

  @MainActor
  func testStartsAConversation() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.entry(FeedFixture.benRecommend).waitForExistence(timeout: 10))

    app.buttons["Start a conversation"].tap()
    let field = app.composerField("Your post")
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertTrue(
      app.staticTexts[
        "Post without choosing a movie or show. Only you and your friends can see it."
      ]
      .exists
    )
    field.typeText("Movie night at my place on Friday?")
    app.buttons["Post"].tap()

    wait(
      for: [
        log.wrote(
          "discussion-post",
          #"{"body":"Movie night at my place on Friday?","spoiler":false}"#
        )
      ],
      timeout: 10
    )
  }

  // A permalink opens the feed at its reply, which shows highlighted, and
  // the reader reacts to it.
  @MainActor
  func testOpensALinkToAReplyAndReacts() throws {
    let log = RequestLog.temporary()
    let app = launchAtHanasLink(requestLog: log.file)
    let reply = app.comment("8")
    XCTAssertTrue(reply.isHittable)
    XCTAssertTrue(reply.staticTexts["Try Paper Lanterns."].exists)
    XCTAssertTrue(app.navigationBars.buttons["Your circle"].exists)

    reply.buttons["React"].tap()
    let picker = reply.otherElements["reaction-picker"]
    XCTAssertTrue(picker.waitForExistence(timeout: 5))
    try app.performShellAudit()
    picker.buttons["Care"].tap()

    wait(
      for: [
        log.wrote("reaction", #"{"item":"\#(FeedFixture.alicePost)","kind":"care","reply":"8"}"#)
      ],
      timeout: 10
    )
  }

  @MainActor
  func testRevealsSpoilers() throws {
    let app = launchAtHanasLink()

    // A spoiler entry hides its text and discussion, but not its label.
    let spoiler = app.entry(FeedFixture.aliceSpoiler)
    app.scrollTo(spoiler)
    XCTAssertTrue(spoiler.staticTexts["Season 2"].exists)
    XCTAssertFalse(spoiler.staticTexts["The season 2 opener had me shouting."].exists)
    XCTAssertFalse(spoiler.buttons["Comment"].exists)
    spoiler.buttons["Contains spoilers · Reveal discussion"].tap()
    XCTAssertTrue(spoiler.staticTexts["The season 2 opener had me shouting."].exists)
    XCTAssertTrue(spoiler.buttons["Comment"].exists)

    // A reply's own flag hides its text and reactions.
    let comment = app.entry(FeedFixture.aliceComment)
    app.scrollTo(comment)
    comment.buttons["View 2 replies"].tap()
    let reply = app.comment("5")
    app.scrollTo(reply)
    XCTAssertFalse(reply.staticTexts["The fog is a person."].exists)
    XCTAssertFalse(reply.buttons["React"].exists)
    reply.buttons["Contains spoilers · Reveal comment"].tap()
    XCTAssertTrue(reply.staticTexts["The fog is a person."].exists)
    XCTAssertTrue(reply.buttons["React"].exists)
  }

  @MainActor
  func testRemovesOnesOwnComment() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    let comment = app.entry(FeedFixture.aliceComment)
    app.scrollTo(comment)
    XCTAssertTrue(comment.staticTexts["Season 1, Episode 3"].exists)
    XCTAssertTrue(comment.staticTexts["4 replies"].exists)
    // Cam's removed comment stays as the placeholder for Alice's reply.
    XCTAssertTrue(app.comment("6").staticTexts["Comment removed"].exists)
    comment.buttons["View 2 replies"].tap()
    let own = app.comment("4")
    app.scrollTo(own)
    // Alice hosts the discussion, so she can also remove Ben's comment.
    XCTAssertTrue(app.comment("3").buttons["Remove"].exists)

    own.buttons["Delete"].tap()
    XCTAssertTrue(
      app.staticTexts["Delete this comment? Its text will be erased."].waitForExistence(timeout: 5)
    )
    let confirm = app.buttons.matching(
      NSPredicate(format: "label == 'Delete' AND NOT (identifier BEGINSWITH 'comment-')")
    )
    app.sheets.buttons["Delete"].exists
      ? app.sheets.buttons["Delete"].tap() : confirm.element(boundBy: confirm.count - 1).tap()

    wait(for: [log.wrote("remove-comment", #"{"id":"4"}"#)], timeout: 10)
  }

  // A failed read beneath a confirmation, as during a deploy, leaves it open
  // to confirm once reads succeed again.
  @MainActor
  func testKeepsAConfirmationThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file, outage: outage))
    let entry = app.entry(FeedFixture.benRecommend)
    XCTAssertTrue(entry.waitForExistence(timeout: 10))
    // Night Crossing is #1 in Alice's top 10, so withdrawing asks first.
    entry.buttons["Recommended"].tap()
    let question = app.staticTexts[
      "Remove your recommendation? Night Crossing also leaves your top 10 at #1."
    ]
    XCTAssertTrue(question.waitForExistence(timeout: 5))

    // The first failed read has replaced the feed beneath with the error by
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

  // Ben posts while the reader is a little way down the feed, reading the
  // second entry. The post waits behind New activity, and showing it puts the
  // post above that entry without moving the entry.
  @MainActor
  func testShowsNewActivityWithoutMovingTheReader() throws {
    let update = FixtureUpdate("screen/feed/incoming")
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(update: update))
    let reading = app.entry(FeedFixture.aliceOrchard)
    XCTAssertTrue(reading.waitForExistence(timeout: 10))
    // Dragging and holding moves the feed without a fling, so the entry
    // rests just below the navigation bar.
    let bar = app.navigationBars["Your circle"].frame.maxY
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
    start.press(
      forDuration: 0.1,
      thenDragTo: start.withOffset(CGVector(dx: 0, dy: bar + 40 - reading.frame.minY)),
      withVelocity: .slow,
      thenHoldForDuration: 0.5
    )

    update.send()
    let newActivity = app.buttons["New activity"]
    XCTAssertTrue(newActivity.waitForExistence(timeout: 10))
    try app.performShellAudit()
    XCTAssertGreaterThanOrEqual(try newActivity.labelContrast(), 4.5)
    let place = reading.frame
    XCTAssertGreaterThan(place.minY, bar)
    newActivity.tap()

    XCTAssertTrue(newActivity.waitForNonExistence(timeout: 5))
    XCTAssertEqual(reading.frame.minY, place.minY, accuracy: 1)
    let post = app.entry(FeedFixture.benNewPost)
    var swipes = 0
    while !(post.exists && post.isHittable) && swipes < 5 {
      app.swipeDown()
      swipes += 1
    }
    XCTAssertTrue(post.isHittable)
    XCTAssertLessThan(post.frame.maxY, reading.frame.minY)
  }

  // Each friends feed fixture loads and shows its entries, its empty
  // message, its linked reply, or that its link is unavailable, without an
  // error.
  @MainActor
  func testRendersEveryFeedFixture() throws {
    let directory = FixtureLaunch.directory.appending(path: "screen/feed")
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path())
      .filter { $0.hasSuffix(".json") }
      .map { String($0.dropLast(".json".count)) }
      .filter { $0 != "not-modified" }
      .sorted()
    XCTAssertEqual(
      names,
      [
        "default", "empty", "incoming", "joined", "linked-reply", "newest-page", "older-page",
        "page", "unavailable-link",
      ]
    )
    for name in names {
      let fixture = try FeedFixtureFile(directory.appending(path: "\(name).json"))
      let app = XCUIApplication()
      app.launch(
        with: FixtureLaunch(
          viewer: fixture.viewer,
          overrides: ["screen/feed/\(name)"],
          link: fixture.path == "/" ? nil : "screenr-dev://\(fixture.path)"
        )
      )
      let expected: XCUIElement =
        if fixture.targetUnavailable {
          app.staticTexts["This activity is unavailable."]
        } else if let reply = fixture.targetReply {
          app.comment(reply)
        } else if let first = fixture.firstEntry {
          app.entry(first)
        } else {
          app.staticTexts["Your entries and friends’ discussions will appear here."]
        }
      XCTAssertTrue(expected.waitForExistence(timeout: 10), "screen/feed/\(name)")
      app.terminate()
    }
  }

  // Hana, Alice's friend, opens a link to Ben's reply on Alice's post.
  @MainActor
  private func launchAtHanasLink(requestLog: URL? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        viewer: "hana",
        link: "screenr-dev:///?item=\(FeedFixture.alicePost)&reply=8",
        requestLog: requestLog
      )
    )
    XCTAssertTrue(app.comment("8").waitForExistence(timeout: 10))
    return app
  }
}

// The parts of a feed fixture a test needs to launch it and know what shows.
private struct FeedFixtureFile {
  let viewer: String
  let path: String
  let targetUnavailable: Bool
  // The entry that sorts first: every fixture entry has the same time, so
  // the lowest ID.
  let firstEntry: String?
  // The reply a permalink fixture links to, which the feed scrolls to.
  let targetReply: String?

  init(_ file: URL) throws {
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    let request = json?["request"] as? [String: Any]
    let query = request?["query"] as? [String: String]
    let body = (json?["response"] as? [String: Any])?["body"] as? [String: Any]
    let entries = body?["conversations"] as? [[String: Any]] ?? []
    viewer = json?["viewer"] as? String ?? "alice"
    // A paged read's window is the app's own; the link names the screen.
    path = withoutWindow(query?["path"] ?? "/")
    targetUnavailable = body?["targetUnavailable"] as? Bool ?? false
    firstEntry = entries.compactMap { $0["id"] as? String }.min()
    targetReply = (body?["target"] as? [String: Any])?["reply"] as? String
  }
}
