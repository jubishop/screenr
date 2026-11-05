import Foundation
import UIKit
import XCTest

// Settings, from the You tab's gear, and the invitations it opens. The
// fixture API answers each write with its recorded response, and its request
// log shows what each write sent. Screens read again after a write still show
// the fixtures, so these tests check the requests and the confirmations.
final class SettingsTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testChangesTheNameAndUsername() throws {
    let log = RequestLog.temporary()
    let app = openSettings(log: log)
    try app.performSettingsAudit()

    app.buttons["Edit profile"].tap()
    let name = app.textFields["Display name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    XCTAssertEqual(name.value as? String, "Alice Park")
    let username = app.textFields["Username"]
    XCTAssertEqual(username.value as? String, "alice")
    try app.performSettingsAudit()

    replaceText(in: username, with: "al")
    XCTAssertFalse(app.buttons["Save"].isEnabled)
    replaceText(in: name, with: "Alice P")
    replaceText(in: username, with: "alice_p")
    app.buttons["Save"].tap()

    wait(
      for: [log.logged(#"POST /api/screenr/profile {"name":"Alice P","username":"alice_p"}"#)],
      timeout: 10
    )
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.navigationBars["Edit profile"].exists)
  }

  // UI tests cannot drive the system photo picker. Under the fixture API,
  // Add and Replace photo choose ScreenrKit's FixturePhoto, a detailed
  // portrait JPEG, which the app crops and compresses as it would a photo
  // from the library.
  @MainActor
  func testUploadsAndRemovesAPhoto() throws {
    let log = RequestLog.temporary()
    let app = openSettings(log: log)

    app.buttons["Replace photo"].tap()

    XCTAssertTrue(app.staticTexts["Photo replaced."].waitForExistence(timeout: 20))
    let upload = try XCTUnwrap(
      try log.loggedLines().first { $0.hasPrefix("POST /api/screenr/photo ") }
    )
    let size = try XCTUnwrap(
      Int(upload.dropFirst("POST /api/screenr/photo image/jpeg ".count).prefix { $0.isNumber })
    )
    XCTAssertGreaterThan(size, 1000)
    XCTAssertLessThanOrEqual(size, 60 * 1024)

    app.buttons["Remove photo"].tap()

    XCTAssertTrue(app.staticTexts["Photo removed."].waitForExistence(timeout: 10))
    wait(for: [log.logged("POST /api/screenr/remove-photo {}")], timeout: 10)
    try app.performSettingsAudit()
  }

  @MainActor
  func testCreatesAndRevokesAnInvitation() throws {
    let log = RequestLog.temporary()
    let app = openSettings(log: log)

    app.buttons["Invite friends"].tap()
    XCTAssertTrue(app.navigationBars["Invite friends"].waitForExistence(timeout: 10))
    let used = app.staticTexts.matching(
      NSPredicate(format: "label BEGINSWITH %@", "1 of 3 signups")
    )
    XCTAssertTrue(used.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Share invitation link"].firstMatch.exists)
    try app.performSettingsAudit()

    let increment = app.steppers.firstMatch.buttons["Increment"]
    increment.tap()
    increment.tap()
    app.buttons["Create invitation"].tap()

    wait(for: [log.logged(#"POST /api/screenr/invite {"limit":3}"#)], timeout: 10)
    XCTAssertTrue(
      app.staticTexts[
        "Invitation created. Share its link with the friends you want to invite."
      ]
      .waitForExistence(timeout: 10)
    )

    app.buttons["Revoke invitation"].firstMatch.tap()
    let revoke = app.buttons["Revoke"]
    XCTAssertTrue(revoke.waitForExistence(timeout: 5))
    revoke.tap()

    wait(
      for: [
        log.logged(
          #"POST /api/screenr/revoke-invite {"id":"a93ecb20-a553-4bee-8e54-0c690ca36d03"}"#
        )
      ],
      timeout: 10
    )
    XCTAssertTrue(
      app.staticTexts["Invitation revoked. Its link no longer works."].waitForExistence(timeout: 10)
    )
  }

  // A failed read beneath Revoke's confirmation, as during a deploy, leaves
  // it open to confirm once reads succeed again.
  @MainActor
  func testKeepsTheRevokeConfirmationThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = openSettings(log: log, outage: outage)
    app.buttons["Invite friends"].tap()
    let revokeInvitation = app.buttons["Revoke invitation"].firstMatch
    XCTAssertTrue(revokeInvitation.waitForExistence(timeout: 10))
    revokeInvitation.tap()
    let question = app.staticTexts["Revoke this invitation? Its link will stop working."]
    XCTAssertTrue(question.waitForExistence(timeout: 5))

    // The first failed read has replaced the invitations beneath with the
    // error by the time the app reads them again.
    outage.begin()
    let reads = try log.screenPaths().count
    wait(
      for: [log.expectation { $0.dropFirst(reads).filter { $0 == "/invites" }.count >= 2 }],
      timeout: 15
    )
    let failure = app.staticTexts["Screenr didn't load"]
    XCTAssertTrue(failure.exists)
    XCTAssertTrue(question.exists)

    outage.end()
    XCTAssertTrue(failure.waitForNonExistence(timeout: 10))
    XCTAssertTrue(question.exists)
    app.buttons["Revoke"].tap()
    wait(
      for: [
        log.logged(
          #"POST /api/screenr/revoke-invite {"id":"a93ecb20-a553-4bee-8e54-0c690ca36d03"}"#
        )
      ],
      timeout: 10
    )
  }

  // The fixture launch's member has not decided about notifications, and
  // allows them when asked.
  @MainActor
  func testTurnsOnNotificationsAndChangesAKind() throws {
    let log = RequestLog.temporary()
    let app = openSettings(log: log)
    let turnOn = app.buttons["Turn on notifications"]
    let comments = app.switches["Comments on your posts"]
    try app.performSettingsAudit()
    app.scrollTo(turnOn)
    for kind in [
      "Friend requests", "Accepted friend requests", "Replies to your comments",
      "Comments on your posts",
    ] {
      app.scrollTo(app.switches[kind])
      XCTAssertEqual(app.switches[kind].value as? String, "1")
    }

    comments.switches.firstMatch.tap()

    wait(for: [log.wrote("push-settings", #"{"comment":false}"#)], timeout: 10)
    app.scrollTo(turnOn)
    turnOn.tap()
    XCTAssertTrue(turnOn.waitForNonExistence(timeout: 10))
  }

  @MainActor
  func testConnectsSignInWithApple() throws {
    let app = openSettings(log: RequestLog.temporary())
    let connect = app.buttons["Connect Apple"]
    app.scrollTo(connect)

    connect.tap()

    // The section's footer reports it, which the screen's next read can
    // leave below the bottom of the list.
    let connected = app.staticTexts["Apple connected."]
    app.scrollTo(connected)
    XCTAssertTrue(connected.exists)
  }

  // Under the fixture API, feedback goes to the request log instead of
  // Sentry, and Attach screenshots chooses ScreenrKit's FixturePhoto, since
  // UI tests cannot drive the photo picker.
  @MainActor
  func testSendsFeedback() throws {
    let log = RequestLog.temporary()
    let app = openSettings(log: log)
    let open = app.buttons["Send feedback"]
    app.scrollTo(open)
    open.tap()
    XCTAssertTrue(app.navigationBars["Send feedback"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Send"].isEnabled)

    let message = app.textFields["Your feedback"]
    message.tap()
    message.typeText("Posters load slowly")
    app.buttons["Attach screenshots"].tap()
    XCTAssertTrue(app.staticTexts["Screenshot 1"].waitForExistence(timeout: 20))
    try app.performSettingsAudit()
    app.buttons["Send"].tap()

    XCTAssertTrue(app.staticTexts["Thanks for your feedback"].waitForExistence(timeout: 10))
    // The app's log comes first. The extensions' follow when they have run
    // in this Simulator, as their tests run them.
    wait(
      for: [
        log.logged(where: {
          $0.hasPrefix(#"FEEDBACK {"logs":["app""#)
            && $0.hasSuffix(#"],"message":"Posters load slowly","screenshots":1}"#)
        })
      ],
      timeout: 10
    )
    app.buttons["Done"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
  }

  // Sentry discards feedback over 4,096 characters, so the form counts them
  // and holds a longer message back, keeping all of it rather than cutting a
  // paste short.
  @MainActor
  func testKeepsFeedbackOverTheLengthLimit() throws {
    let app = openSettings(log: RequestLog.temporary())
    let open = app.buttons["Send feedback"]
    app.scrollTo(open)
    open.tap()
    XCTAssertTrue(app.navigationBars["Send feedback"].waitForExistence(timeout: 10))
    let empty = app.textFields["Your feedback"]
    // 4,115 characters.
    UIPasteboard.general.string = Array(repeating: "Posters load slowly.", count: 196)
      .joined(separator: " ")
    empty.tap()
    // A second tap in the empty field opens its edit menu.
    empty.tap()
    let paste = app.menuItems["Paste"]
    XCTAssertTrue(paste.waitForExistence(timeout: 5))

    paste.tap()

    XCTAssertTrue(app.staticTexts["4115 / 4096"].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts["Shorten your message to 4,096 characters or fewer."].exists
    )
    XCTAssertFalse(app.buttons["Send"].isEnabled)
    // Once the field holds text, it goes by its text instead of its placeholder.
    let message = app.textFields.element(
      matching: NSPredicate(format: "value BEGINSWITH %@", "Posters load slowly.")
    )
    XCTAssertEqual((message.value as? String)?.count, 4115)
    try app.performScreenrAudit()
  }

  @MainActor
  func testSignsOut() throws {
    let app = openSettings(log: RequestLog.temporary())
    let signOut = app.buttons["Sign out"]
    app.scrollTo(signOut)
    try app.performSettingsAudit()
    // The audit can scroll the list.
    app.scrollTo(signOut)

    signOut.tap()

    XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tab("You").exists)
  }

  // A sign-out the server could not confirm says so, and a failed read
  // beneath the alert, as when the phone goes offline, leaves it up.
  @MainActor
  func testKeepsTheSignOutFailureThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = openSettings(log: log, overrides: ["auth/sign-out/failed"], outage: outage)
    let signOut = app.buttons["Sign out"]
    app.scrollTo(signOut)
    signOut.tap()
    let alert = app.alerts["Could not sign out"]
    XCTAssertTrue(alert.waitForExistence(timeout: 10))
    XCTAssertTrue(alert.staticTexts["Could not sign out. Try again."].exists)

    // The first failed read has replaced the sections beneath with the error
    // by the time the app reads them again.
    outage.begin()
    let reads = try log.screenPaths().count
    wait(
      for: [log.expectation { $0.dropFirst(reads).filter { $0 == "/account" }.count >= 2 }],
      timeout: 15
    )
    XCTAssertTrue(alert.exists)
    alert.buttons["OK"].tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 10))
    let failure = app.staticTexts["Screenr didn't load"]
    XCTAssertTrue(failure.exists)

    outage.end()
    XCTAssertTrue(failure.waitForNonExistence(timeout: 10))
  }

  // Changes the server refused keep saying so through a failed read beneath
  // their sections, as when the phone goes offline.
  @MainActor
  func testKeepsSettingsFailuresThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let app = openSettings(
      log: log,
      overrides: ["actions/push-settings/failed", "auth/link-social/invalid-token"],
      outage: outage
    )
    let comments = app.switches["Comments on your posts"]
    app.scrollTo(comments)
    comments.switches.firstMatch.tap()
    let pushFailure = app.staticTexts["Something went wrong. Please try again."]
    XCTAssertTrue(pushFailure.waitForExistence(timeout: 10))
    let connect = app.buttons["Connect Apple"]
    app.scrollTo(connect)
    connect.tap()
    let linkFailure = app.staticTexts["Screenr could not confirm your Apple account. Try again."]
    app.scrollTo(linkFailure)

    try failReads(beneath: app, log: log, outage: outage)

    app.scrollTo(pushFailure)
    app.scrollTo(linkFailure)
  }

  // Changes still saving through a failed read beneath their sections show as
  // saving once the sections return, and then how they ended.
  @MainActor
  func testKeepsSettingsChangesInFlightThroughAFailedRead() throws {
    let log = RequestLog.temporary()
    let outage = FixtureOutage()
    let holds = FixtureHolds()
    let app = openSettings(
      log: log,
      overrides: ["auth/link-social/invalid-token"],
      outage: outage,
      holds: holds
    )
    for path in ["/api/screenr/photo", "/api/screenr/activity-email", "/api/auth/link-social"] {
      holds.hold(path)
    }
    app.buttons["Replace photo"].tap()
    let savingPhoto = app.buttons["Saving…"]
    XCTAssertTrue(savingPhoto.waitForExistence(timeout: 10))
    wait(for: [log.logged(where: { $0.hasPrefix("POST /api/screenr/photo ") })], timeout: 20)
    let email = app.switches["Email me about new activity"]
    app.scrollTo(email)
    XCTAssertEqual(email.value as? String, "0")
    email.switches.firstMatch.tap()
    wait(for: [log.logged(#"POST /api/screenr/activity-email {"enabled":true}"#)], timeout: 10)
    XCTAssertEqual(email.value as? String, "1")
    let connect = app.buttons["Connect Apple"]
    app.scrollTo(connect)
    connect.tap()
    let connecting = app.buttons["Connecting…"]
    XCTAssertTrue(connecting.waitForExistence(timeout: 10))
    wait(for: [log.logged(where: { $0.hasPrefix("POST /api/auth/link-social ") })], timeout: 10)

    try failReads(beneath: app, log: log, outage: outage)

    XCTAssertTrue(savingPhoto.exists)
    holds.release("/api/screenr/photo")
    XCTAssertTrue(app.staticTexts["Photo replaced."].waitForExistence(timeout: 10))
    app.scrollTo(email)
    XCTAssertEqual(email.value as? String, "1")
    app.scrollTo(connecting)
    XCTAssertFalse(connecting.isEnabled)
    holds.release("/api/auth/link-social")
    XCTAssertTrue(connect.waitForExistence(timeout: 10))
    app.scrollTo(app.staticTexts["Screenr could not confirm your Apple account. Try again."])
    holds.release("/api/screenr/activity-email")
  }

  // At the largest accessibility text size, every Settings control and Invite
  // friends' controls can still be reached and tapped.
  @MainActor
  func testFitsTheLargestTextSize() throws {
    let app = openSettings(
      log: RequestLog.temporary(),
      textSize: "UICTContentSizeCategoryAccessibilityXXXL"
    )
    for control in [
      app.buttons["Edit profile"], app.buttons["Replace photo"],
      app.buttons["Use my Google photo"], app.buttons["Remove photo"],
      app.buttons["Invite friends"],
    ] {
      app.scrollTo(control)
    }

    app.buttons["Invite friends"].tap()
    XCTAssertTrue(app.navigationBars["Invite friends"].waitForExistence(timeout: 10))
    for control in [
      app.buttons["Create invitation"], app.buttons["Share invitation link"].firstMatch,
      app.buttons["Revoke invitation"].firstMatch,
    ] {
      app.scrollTo(control)
    }
    app.navigationBars["Invite friends"].buttons.element(boundBy: 0).tap()

    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    for control in [
      app.buttons["Turn on notifications"], app.switches["Replies to your comments"],
      app.switches["Email me about new activity"], app.buttons["Connect Apple"],
      app.buttons["Send feedback"], app.buttons["Sign out"], app.buttons["Delete account"],
    ] {
      app.scrollTo(control)
    }
  }

  @MainActor
  private func openSettings(
    log: RequestLog,
    overrides: [String] = [],
    textSize: String? = nil,
    outage: FixtureOutage? = nil,
    holds: FixtureHolds? = nil
  ) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        overrides: overrides,
        requestLog: log.file,
        textSize: textSize,
        outage: outage,
        holds: holds
      )
    )
    XCTAssertTrue(app.tab("You").waitForExistence(timeout: 10))
    app.tab("You").tap()
    app.buttons["Settings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Edit profile"].waitForExistence(timeout: 10))
    return app
  }

  // Fails Settings' reads, as when the phone goes offline, until the error
  // has replaced the sections, then ends the outage and waits for them to
  // return, with the list scrolled to its top.
  @MainActor
  private func failReads(
    beneath app: XCUIApplication,
    log: RequestLog,
    outage: FixtureOutage
  ) throws {
    // The first failed read has replaced the sections with the error by the
    // time the app reads them again.
    outage.begin()
    let reads = try log.screenPaths().count
    wait(
      for: [log.expectation { $0.dropFirst(reads).filter { $0 == "/account" }.count >= 2 }],
      timeout: 15
    )
    let failure = app.staticTexts["Screenr didn't load"]
    XCTAssertTrue(failure.exists)

    outage.end()
    XCTAssertTrue(failure.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Edit profile"].waitForExistence(timeout: 10))
  }

  // Puts the cursor at the end of the field's text, deletes it, and types.
  @MainActor
  private func replaceText(in field: XCUIElement, with text: String) {
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    let current = field.value as? String ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    field.typeText(text)
  }
}

extension XCUIApplication {
  // The accessibility audit for Settings, its sheets, and Invite friends. On
  // the iOS 27 Simulator, the audit flags the system's grouped list text, such
  // as section headers, footers, and rows, as not scaling with Dynamic Type
  // or as clipping, though it uses text styles, so it leaves out those two
  // checks; `testFitsTheLargestTextSize` checks those screens at the largest
  // size instead. Leaving them out also keeps the list still: the Dynamic
  // Type check changes the text size, which scrolls a long list while the
  // contrast check samples its colors. The audit passes over contrast
  // reports it cannot place or that the glass covers: failures with no
  // element, which these long lists raise for rows sampled beneath the
  // navigation bar's blur or the sheet's bottom edge, and failures on an
  // element beneath the navigation bar or the keyboard, or past the screen's
  // edge, as `performShellAudit` does. A failure on an element in view still
  // fails, once `performSettledAudit` has audited the settled screen again.
  @MainActor
  func performSettingsAudit() throws {
    try performSettledAudit(for: .screenr.subtracting([.dynamicType, .textClipped])) {
      let screen = windows.firstMatch.frame
      let covers = glassCovers()
      return { issue in
        switch issue.auditType {
        case .contrast:
          guard let frame = issue.element?.frame else { return true }
          return !screen.contains(frame) || covers.contains { $0.intersects(frame) }
        default: return false
        }
      }
    }
  }
}
