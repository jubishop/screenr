import Foundation
import XCTest

extension XCUIApplication {
  func tab(_ name: String) -> XCUIElement {
    tabBars.buttons[name]
  }

  // The accessibility audit for screens in the tabs. It passes over two
  // things the system sizes: navigation bars keep the wordmark's size, as
  // they do their titles, and the large content viewer shows it larger; and
  // the audit flags the system's search field as clipping at large text
  // sizes.
  func performShellAudit() throws {
    try performAccessibilityAudit { issue in
      switch issue.auditType {
      case .dynamicType: issue.element?.label == "screenr"
      case .textClipped: issue.element?.elementType == .searchField
      default: false
      }
    }
  }
}

// The fixture API's request log, a line per API request, such as
// `GET /api/screenr/screen?path=%2Fpeople`, with ` visit` after the app's
// visit. It shows which screens the app read, and when, whatever the screens
// look like.
struct RequestLog {
  let file: URL

  static func temporary() -> RequestLog {
    RequestLog(
      file: FileManager.default.temporaryDirectory
        .appending(path: "requests-\(UUID().uuidString).log")
    )
  }

  private struct ScreenRead {
    let path: String
    // Words after the request, such as `visit`.
    let marks: ArraySlice<Substring>
  }

  // Each screen the app read, in order.
  private func screenReads() throws -> [ScreenRead] {
    try String(contentsOf: file, encoding: .utf8)
      .split(separator: "\n")
      .compactMap { line -> ScreenRead? in
        let words = line.split(separator: " ")
        guard words.count >= 2, words[0] == "GET",
          words[1].hasPrefix("/api/screenr/screen?"),
          let components = URLComponents(string: String(words[1])),
          let path = components.queryItems?.first(where: { $0.name == "path" })?.value
        else { return nil }
        return ScreenRead(path: path, marks: words.dropFirst(2))
      }
  }

  // The member path of each screen the app read, in order.
  func screenPaths() throws -> [String] {
    try screenReads().map(\.path)
  }

  // The positions, among the screen reads, of the reads sent as visits.
  func visits() throws -> [Int] {
    try screenReads().enumerated()
      .filter { $0.element.marks.contains("visit") }
      .map(\.offset)
  }

  // Fulfilled once `isMet` holds for the screens read so far. A log the app
  // has not written yet leaves it unfulfilled.
  func expectation(_ isMet: @escaping @Sendable ([String]) -> Bool) -> XCTestExpectation {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          return isMet(try screenPaths())
        } catch {
          return false
        }
      },
      object: nil
    )
  }

  // Fulfilled once the app has read screens at least `count` times.
  func screenReads(atLeast count: Int) -> XCTestExpectation {
    expectation { $0.count >= count }
  }

  // Fulfilled once the app has read the screen at `path` after its first
  // `earlier` reads.
  func read(_ path: String, after earlier: Int = 0) -> XCTestExpectation {
    expectation { $0.dropFirst(earlier).contains(path) }
  }
}
