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
