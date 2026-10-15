import Foundation
import XCTest

// Profiles against the fixture API: a friend's profile with their top 10,
// friends, and activity; a member who is not a friend, who sees only the
// profile and top 10; Unfriend and Block, which ask first; and every profile
// fixture. Writes are checked in the fixture API's request log.
final class ProfileTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // Ben's profile opens from Friends with his top 10, friends, and entries.
  @MainActor
  func testOpensAFriendsProfile() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people", requestLog: log.file))
    let row = app.buttons(starting: "Ben Ortiz")
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()

    XCTAssertTrue(app.navigationBars["Ben Ortiz"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Friends").isSelected)
    XCTAssertTrue(app.staticTexts["@ben"].exists)
    XCTAssertTrue(app.buttons["Watch together"].exists)
    XCTAssertTrue(app.buttons["#1 Night Crossing"].exists)
    XCTAssertTrue(app.buttons["#2 Harbor Lights"].exists)
    XCTAssertTrue(app.entry(FeedFixture.benRecommend).waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["You’ll see their activity after you become friends."].exists)
    try app.performShellAudit()

    // His friends, collapsed beneath their count, open their profiles.
    app.buttons["Friends (3)"].tap()
    let cam = app.buttons(starting: "Cam Rivera")
    XCTAssertTrue(cam.waitForExistence(timeout: 5))
    try app.performShellAudit()

    app.buttons["#1 Night Crossing"].tap()
    XCTAssertTrue(app.navigationBars["Night Crossing"].waitForExistence(timeout: 10))
    wait(for: [log.read("/titles/movie/101")], timeout: 10)
  }

  // Unfriend waits in More actions and asks first; tapping outside its
  // confirmation changes nothing.
  @MainActor
  func testUnfriendsOnceConfirmed() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/ben", requestLog: log.file))
    XCTAssertTrue(app.buttons["Watch together"].waitForExistence(timeout: 10))

    app.buttons["More actions for Ben Ortiz"].tap()
    app.buttons["Unfriend"].tap()
    let question = app.staticTexts["Unfriend Ben Ortiz?"]
    XCTAssertTrue(question.waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts["You’ll both lose access to each other’s posts and discussions."].exists
    )
    app.otherElements["PopoverDismissRegion"]
      .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
      .tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 10))

    app.buttons["More actions for Ben Ortiz"].tap()
    app.buttons["Unfriend"].tap()
    let unfriend = app.popovers.buttons["Unfriend"]
    XCTAssertTrue(unfriend.waitForExistence(timeout: 10))
    unfriend.tap()

    wait(for: [log.wrote("relationship", #"{"action":"remove","target":"user-ben"}"#)], timeout: 10)
    XCTAssertEqual(try log.loggedLines().filter { $0.hasPrefix("POST") }.count, 1)
  }

  // Someone who is not a friend sees the profile and top 10 but not the
  // activity. A friend request sends at once; Block asks first, then opens
  // Friends with the result.
  @MainActor
  func testRequestsAndBlocksSomeoneWhoIsNotAFriend() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/erin", requestLog: log.file))
    let request = app.buttons["Send friend request"]
    XCTAssertTrue(request.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["You’ll see their activity after you become friends."].exists)
    XCTAssertTrue(app.buttons["#1 Copper Coast"].exists)
    XCTAssertFalse(app.buttons["Watch together"].exists)
    try app.performShellAudit()

    request.tap()
    wait(
      for: [log.wrote("relationship", #"{"action":"request","target":"user-erin"}"#)],
      timeout: 10
    )

    app.buttons["More actions for Erin Walsh"].tap()
    XCTAssertFalse(app.buttons["Unfriend"].exists)
    app.buttons["Block"].tap()
    XCTAssertTrue(app.staticTexts["Block Erin Walsh?"].waitForExistence(timeout: 10))
    app.popovers.buttons["Block"].tap()

    wait(for: [log.wrote("relationship", #"{"action":"block","target":"user-erin"}"#)], timeout: 10)
    XCTAssertTrue(app.navigationBars["Friends"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Friends").isSelected)
    let notice = app.staticTexts["You blocked Erin Walsh."]
    XCTAssertTrue(notice.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Block Erin Walsh?"].waitForNonExistence(timeout: 10))
    try app.performShellAudit()
    app.buttons["Dismiss"].tap()
    XCTAssertTrue(notice.waitForNonExistence(timeout: 10))
    // The profile closed on Circle, where the link opened it.
    app.tab("Circle").tap()
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://people/erin",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(app.buttons["Send friend request"].waitForExistence(timeout: 10))
    try app.performShellAudit()
  }

  // Each profile fixture loads with its person, relationship action, top 10,
  // and activity or the friends-only note, or says the person is not found.
  @MainActor
  func testRendersEveryProfileFixture() throws {
    let names = try FixtureNames.list("screen/profile")
    XCTAssertEqual(
      names,
      [
        "empty-top-ten", "friend", "full-top-ten", "joined", "not-found", "own",
        "pending-request", "sent-request",
      ]
    )
    let fixtures = try names.map { try ScreenFixtureFile("screen/profile/\($0)") }
    // One launch for each viewer opens each of their fixtures' links.
    for viewer in Set(fixtures.map(\.viewer)).sorted() {
      let app = XCUIApplication()
      app.launch(with: FixtureLaunch(viewer: viewer))
      XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10), viewer)
      for fixture in fixtures where fixture.viewer == viewer {
        try app.openFixture(fixture)
        try checkProfile(app, fixture)
      }
      app.terminate()
    }
  }

  // The fixture's person, relationship action, top 10, and activity or the
  // friends-only note, or that the person is not found.
  @MainActor
  private func checkProfile(_ app: XCUIApplication, _ fixture: ScreenFixtureFile) throws {
    let label = fixture.name
    guard let profile = fixture.body["profile"] as? [String: Any],
      let displayName = profile["display_name"] as? String
    else {
      XCTAssertEqual(fixture.status, 404, label)
      XCTAssertTrue(app.staticTexts["Person not found."].waitForExistence(timeout: 10), label)
      return
    }
    XCTAssertTrue(app.navigationBars[displayName].waitForExistence(timeout: 10), label)
    XCTAssertTrue(
      app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Friends ('")).firstMatch.exists,
      label
    )
    let topTen = fixture.body["topTen"] as? [[String: Any]] ?? []
    if let first = topTen.first, let title = first["name"] as? String {
      XCTAssertTrue(app.buttons["#1 \(title)"].exists, label)
    }
    if fixture.viewer == profile["username"] as? String {
      XCTAssertTrue(app.staticTexts["Top 10"].exists, label)
      XCTAssertFalse(
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'More actions'")).firstMatch
          .exists,
        label
      )
    } else {
      XCTAssertTrue(app.buttons["More actions for \(displayName)"].exists, label)
      let action =
        if profile["accepted_at"] is String {
          "Watch together"
        } else if let requester = profile["requested_by"] as? String {
          requester == "user-\(fixture.viewer)"
            ? "Cancel friend request" : "Accept friend request"
        } else {
          "Send friend request"
        }
      XCTAssertTrue(app.buttons[action].exists, label)
    }
    if profile["can_read"] as? Bool == false {
      XCTAssertTrue(
        app.staticTexts["You’ll see their activity after you become friends."].exists,
        label
      )
    }
    XCTAssertFalse(app.staticTexts["Screenr didn't load"].exists, label)
  }
}
