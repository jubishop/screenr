import Foundation
import XCTest

// Fixture entries and replies the feed tests use.
enum FeedFixture {
  // Ben recommends Night Crossing; a blocked member's comment is unavailable,
  // with Ben's reply 2 beneath it.
  static let benRecommend = "0601645c-005d-450f-8b22-ae05a508119d"
  // Alice wants to watch The Quiet Orchard, the entry after Ben's recommend.
  static let aliceOrchard = "0901c192-5fc6-4968-8b1e-d3cd4dda8ab7"
  // Alice's Harbor Lights comment, Season 1, Episode 3: Ben's comment 3 with
  // Alice's reply 4 and Ben's spoiler reply 5, and Cam's removed comment 6.
  static let aliceComment = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
  // Alice's spoiler comment about Harbor Lights, Season 2.
  static let aliceSpoiler = "d5c4b90c-6ca6-40f7-83ca-ce19d41f44cc"
  // Alice's post without a title, with Ben's reply 8.
  static let alicePost = "872a205a-bab2-48f8-8c27-b737397eb469"
  // Cam's deleted post, kept for Ben's reply 9.
  static let camPost = "46cdc1d2-e78b-4103-8d5e-2081a05f727b"
  // Alice's Paper Lanterns card: her Finished entry holds it, with her review
  // and Recommend.
  static let aliceCard = "e1989f51-e93f-414c-8ae3-30f8ac20f409"
  // Ben's Harbor Lights card: his edited spoiler review holds it, with his
  // Recommend.
  static let benCard = "f0a222c0-d2f9-45e6-8f45-53413b726eed"
  // Ben's new post in `screen/feed/incoming`, which sorts first.
  static let benNewPost = "00000000-0000-4000-8000-000000000001"
}

extension XCUIApplication {
  func entry(_ id: String) -> XCUIElement {
    otherElements["entry-\(id)"]
  }

  func comment(_ id: String) -> XCUIElement {
    otherElements["comment-\(id)"]
  }

  // A composer's text field by its label, such as "Add your reply".
  func composerField(_ label: String) -> XCUIElement {
    descendants(matching: .any)
      .matching(
        NSPredicate(
          format: "label == %@ AND (elementType == %d OR elementType == %d)",
          label,
          XCUIElement.ElementType.textView.rawValue,
          XCUIElement.ElementType.textField.rawValue
        )
      )
      .firstMatch
  }

  // Scrolls the feed until the element is on screen. Until the lazy list
  // loads the element, it swipes quickly down the feed; then it moves
  // slowly toward the element, up or down, so it settles on screen.
  @MainActor
  func scrollTo(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
    var swipes = 0
    while !(element.exists && element.isHittable) && swipes < 25 {
      if !element.exists {
        swipeUp()
      } else if element.frame.maxY < frame.midY {
        swipeDown(velocity: .slow)
      } else {
        swipeUp(velocity: .slow)
      }
      swipes += 1
    }
    XCTAssertTrue(element.isHittable, "Could not scroll to \(element)", file: file, line: line)
  }

  // Drags the feed without a fling until the element rests with its middle
  // near `y`. Each drag stays between the navigation bar and the keyboard,
  // or the tab bar while the keyboard is down: a drag into the keyboard
  // would dismiss it.
  @MainActor
  func drag(_ element: XCUIElement, toY y: CGFloat) {
    let top = navigationBars.firstMatch.frame.maxY + 20
    let keyboard = otherElements["inputView"]
    let bottom = (keyboard.exists ? keyboard.frame.minY : tabBars.firstMatch.frame.minY) - 20
    for _ in 0..<3 {
      let distance = y - element.frame.midY
      guard abs(distance) > 20 else { return }
      let step = max(min(distance, bottom - top), top - bottom)
      let start = coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: frame.midX, dy: step < 0 ? bottom : top))
      start.press(
        forDuration: 0.1,
        thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
        withVelocity: .slow,
        thenHoldForDuration: 0.5
      )
    }
  }

  // Waits for the keyboard, and for the elements to settle above it and
  // beneath the navigation bar. The keyboard's view holds the typing
  // predictions above its keys, which the Keyboard element leaves out.
  @MainActor
  func expectAboveTheKeyboard(
    _ elements: XCUIElement...,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let keyboard = otherElements["inputView"]
    XCTAssertTrue(keyboard.waitForExistence(timeout: 10), file: file, line: line)
    let bar = navigationBars.firstMatch.frame.maxY
    let shown = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        MainActor.assumeIsolated {
          elements.allSatisfy {
            $0.exists && $0.frame.minY >= bar && $0.frame.maxY <= keyboard.frame.minY
          }
        }
      },
      object: nil
    )
    let result = XCTWaiter.wait(for: [shown], timeout: 10)
    XCTAssertEqual(
      result,
      .completed,
      "Not between the bar's bottom, \(bar), and the keyboard's top, "
        + "\(keyboard.frame.minY): \(elements.map(\.frame))",
      file: file,
      line: line
    )
  }
}

extension XCUIElement {
  // The first button within whose label starts with `prefix`.
  func buttons(starting prefix: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }
}

extension RequestLog {
  // Every line the fixture API logged, such as
  // `POST /api/screenr/remove-comment {"id":"4"}`.
  func loggedLines() throws -> [String] {
    try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init)
  }

  // Fulfilled once the app sent this write and then read its screen again.
  // `body` is the JSON the fixture API logs, with sorted keys.
  func wrote(_ action: String, _ body: String) -> XCTestExpectation {
    let write = "POST /api/screenr/\(action) \(body)"
    return XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          let lines = try loggedLines()
          guard let index = lines.firstIndex(of: write) else { return false }
          return lines[(index + 1)...].contains { $0.hasPrefix("GET /api/screenr/screen?") }
        } catch {
          return false
        }
      },
      object: nil
    )
  }
}
