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
// `GET /api/screenr/screen?path=%2Fpeople`. It shows which screens the app
// read, and when, whatever the screens look like.
struct RequestLog {
  let file: URL

  static func temporary() -> RequestLog {
    RequestLog(
      file: FileManager.default.temporaryDirectory
        .appending(path: "requests-\(UUID().uuidString).log")
    )
  }

  // The member path of each screen the app read, in order.
  func screenPaths() throws -> [String] {
    try String(contentsOf: file, encoding: .utf8)
      .split(separator: "\n")
      .compactMap { line -> String? in
        guard line.hasPrefix("GET /api/screenr/screen?"),
          let components = URLComponents(string: String(line.dropFirst("GET ".count)))
        else { return nil }
        return components.queryItems?.first { $0.name == "path" }?.value
      }
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
