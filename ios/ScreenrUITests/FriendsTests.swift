import Foundation
import XCTest

// The Friends tab against the fixture API: answering and sending friend
// requests, finding a username, and every Friends fixture. The fixture API
// keeps no state, so these journeys read what each action sent from the
// request log.
final class FriendsTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // Accept answers Fay's request, Decline asks first, and People you may
  // know sends a request to Erin. Cancel and Unblock act at once.
  @MainActor
  func testSendsAndAnswersFriendRequests() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people", requestLog: log.file))
    let fay = app.person("fay")
    XCTAssertTrue(fay.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Requests"].exists)
    try app.performShellAudit()

    // The confirmation is a popover; tapping outside it cancels.
    fay.buttons["Decline"].tap()
    let question = app.staticTexts["Decline Fay Chen’s friend request?"]
    XCTAssertTrue(question.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["The request will be removed."].exists)
    app.otherElements["PopoverDismissRegion"]
      .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
      .tap()
    XCTAssertTrue(question.waitForNonExistence(timeout: 10))

    fay.buttons["Accept"].tap()
    wait(for: [log.wrote("relationship", #"{"action":"accept","target":"user-fay"}"#)], timeout: 10)

    fay.buttons["Decline"].tap()
    let decline = app.popovers.buttons["Decline"]
    XCTAssertTrue(decline.waitForExistence(timeout: 10))
    decline.tap()
    wait(for: [log.wrote("relationship", #"{"action":"remove","target":"user-fay"}"#)], timeout: 10)

    let gus = app.person("gus")
    app.scrollTo(gus)
    XCTAssertTrue(gus.staticTexts["Request sent"].exists)
    gus.buttons["Cancel"].tap()
    wait(for: [log.wrote("relationship", #"{"action":"remove","target":"user-gus"}"#)], timeout: 10)

    let erin = app.person("erin")
    app.scrollTo(erin)
    XCTAssertTrue(app.staticTexts["People you may know"].exists)
    XCTAssertTrue(erin.links["Ben Ortiz (@ben)"].exists)
    erin.buttons["Send friend request"].tap()
    wait(
      for: [log.wrote("relationship", #"{"action":"request","target":"user-erin"}"#)],
      timeout: 10
    )

    // A blocked person shows only their name, without a link.
    let dana = app.person("dana")
    app.scrollTo(dana)
    XCTAssertFalse(dana.staticTexts["@dana"].exists)
    dana.buttons["Unblock"].tap()
    wait(
      for: [log.wrote("relationship", #"{"action":"unblock","target":"user-dana"}"#)],
      timeout: 10
    )
    try app.performShellAudit()
  }

  // An exact username opens that person's profile, whatever its case.
  @MainActor
  func testFindsAnExactUsername() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people", requestLog: log.file))
    let field = app.textFields["Username"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))

    field.tap()
    field.typeText("Erin Walsh")
    app.buttons["Find"].tap()
    let problem = app.staticTexts["Enter a username of 3–24 letters, numbers, or underscores."]
    XCTAssertTrue(problem.waitForExistence(timeout: 5))

    field.clearAndType("Erin")
    app.buttons["Find"].tap()

    XCTAssertTrue(app.navigationBars["Erin Walsh"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Friends").isSelected)
    wait(for: [log.read("/people/erin")], timeout: 10)
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://people",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(app.person("fay").waitForExistence(timeout: 10))
    try app.performShellAudit()
  }

  // Each Friends fixture loads and shows its sections or its starting hint.
  @MainActor
  func testRendersEveryFriendsFixture() throws {
    let names = try FixtureNames.list("screen/people")
    XCTAssertEqual(names, ["default", "empty"])
    for name in names {
      let fixture = try ScreenFixtureFile("screen/people/\(name)")
      let app = XCUIApplication()
      app.launch(
        with: FixtureLaunch(
          viewer: fixture.viewer,
          overrides: ["screen/people/\(name)"],
          link: "screenr-dev://people"
        )
      )
      let connections = fixture.body["connections"] as? [[String: Any]] ?? []
      let expected =
        if let first = connections.first?["display_name"] as? String {
          app.buttons(starting: first)
        } else {
          app.staticTexts[
            "Start with someone you know. Find their username or send an invitation."
          ]
        }
      XCTAssertTrue(expected.waitForExistence(timeout: 10), "screen/people/\(name)")
      let suggestions = app.staticTexts["People you may know"]
      app.scrollTo(suggestions)
      XCTAssertFalse(app.staticTexts["Screenr didn't load"].exists, "screen/people/\(name)")
      app.terminate()
    }
  }
}

extension XCUIElement {
  // Replaces a text field's text.
  @MainActor
  func clearAndType(_ text: String) {
    tap()
    let current = value as? String ?? ""
    typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count) + text)
  }
}

extension XCUIApplication {
  // A person's row on Friends, with its actions, by username.
  func person(_ username: String) -> XCUIElement {
    otherElements["person-\(username)"]
  }
}

// The fixture files in one directory of `ScreenrKit/Fixtures`, by name.
enum FixtureNames {
  static func list(_ directory: String) throws -> [String] {
    try FileManager.default
      .contentsOfDirectory(atPath: FixtureLaunch.directory.appending(path: directory).path())
      .filter { $0.hasSuffix(".json") }
      .map { String($0.dropLast(".json".count)) }
      .sorted()
  }
}

// The parts of a screen fixture a test needs to launch it and know what
// shows: who reads it, its path and status, and its response body.
struct ScreenFixtureFile {
  // Such as `screen/profile/friend`.
  let name: String
  let viewer: String
  let path: String
  let status: Int
  let body: [String: Any]

  init(_ name: String) throws {
    self.name = name
    let file = FixtureLaunch.directory.appending(path: "\(name).json")
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    let request = json?["request"] as? [String: Any]
    let response = json?["response"] as? [String: Any]
    viewer = json?["viewer"] as? String ?? "alice"
    path = (request?["query"] as? [String: String])?["path"] ?? "/"
    status = response?["status"] as? Int ?? 200
    body = response?["body"] as? [String: Any] ?? [:]
  }

  // The fixture's path as a Screenr Dev link.
  var link: String { "screenr-dev://" + path.dropFirst() }
}

extension XCUIApplication {
  // Opens a screen fixture's link in the running app, as the system delivers
  // it. The fixture API answers each path with the launch viewer's fixture
  // for it, so one launch reaches every fixture of that viewer.
  @MainActor
  func openFixture(_ fixture: ScreenFixtureFile) throws {
    XCUIDevice.shared.system.open(try XCTUnwrap(URL(string: fixture.link)))
  }
}
