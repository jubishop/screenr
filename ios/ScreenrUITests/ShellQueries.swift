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
  // sizes. It also passes over what it cannot measure in a scrolling screen:
  // the contrast and clipping of text beneath the glass bars or the keyboard,
  // and Dynamic Type for scrolling content, which larger text moves past the
  // screen's ends. Launch with `FixtureLaunch(textSize:)` to audit a screen
  // at the largest text size instead.
  func performShellAudit() throws {
    try performSettledAudit {
      let screen = windows.firstMatch.frame
      // Content also scrolls beneath the tab bar.
      var covers = glassCovers()
      if tabBars.firstMatch.exists {
        let top = tabBars.firstMatch.frame.minY
        covers.append(CGRect(x: 0, y: top, width: screen.width, height: screen.maxY - top))
      }
      let scrolling = scrollViews.firstMatch.exists ? scrollViews.firstMatch.frame : .null
      let isCovered = { (frame: CGRect) in
        !screen.contains(frame) || covers.contains { $0.intersects(frame) }
      }
      // An issue without an element is in a part of a list row that VoiceOver
      // reads with the rest of the row, so the audit cannot place it. It
      // counts as covered while any row reaches beneath a cover. One snapshot
      // finds the rows, since querying elements while the audit runs can
      // outlast it.
      let rowsCovered = Self.cells(in: try snapshot()).contains { isCovered($0.frame) }
      return { issue in
        var covered = rowsCovered
        var scrolls = false
        if let frame = issue.element?.frame {
          covered = isCovered(frame)
          scrolls = scrolling.contains(frame)
        }
        switch issue.auditType {
        case .dynamicType:
          return issue.element?.label == "screenr" || scrolls
        case .textClipped:
          return issue.element?.elementType == .searchField || covered
        case .contrast:
          return covered
        default:
          return false
        }
      }
    }
  }

  // Runs the accessibility audit, passing over the issues that the handler
  // `expecting` returns accepts. The audit samples colors from the screen,
  // so text that is still moving, such as a list still slowing after a
  // swipe, can fail contrast, and a busy Mac can run the audit out of time.
  // After such a failure, the screen settles and the audit runs once more
  // with a new handler, and only a second failure fails the test, so a real
  // problem, which fails both times, still does. `types` limits the audit.
  func performSettledAudit(
    for types: XCUIAccessibilityAuditType = .all,
    expecting: () throws -> (XCUIAccessibilityAuditIssue) -> Bool
  ) throws {
    var failed = false
    do {
      let isExpected = try expecting()
      try performAccessibilityAudit(for: types) { issue in
        if !isExpected(issue) { failed = true }
        return true
      }
    } catch {
      failed = true
    }
    guard failed else { return }
    try XCTContext.runActivity(named: "Audit again once the screen settles") { _ in
      let settled = XCTestExpectation(description: "The screen settles")
      settled.isInverted = true
      _ = XCTWaiter.wait(for: [settled], timeout: 2)
      try performAccessibilityAudit(for: types, try expecting())
    }
  }

  private static func cells(in snapshot: any XCUIElementSnapshot) -> [any XCUIElementSnapshot] {
    let inner = snapshot.children.flatMap { cells(in: $0) }
    return snapshot.elementType == .cell ? [snapshot] + inner : inner
  }

  // The parts of the screen that content scrolls beneath, the status and
  // navigation bars and the keyboard, whose glass hides text from the audit's
  // contrast check. A sheet's navigation bar sits below the status bar, so a
  // navigation bar covers the screen from its top down to the bar's bottom.
  // A bar behind a sheet covers nothing the audit reaches, and can reach
  // below the sheet's own bar, so only bars in front count.
  func glassCovers() -> [CGRect] {
    let screen = windows.firstMatch.frame
    var covers = [keyboards.firstMatch].filter(\.exists).map(\.frame)
    for bar in navigationBars.allElementsBoundByIndex where bar.exists && bar.isHittable {
      let bottom = bar.frame.maxY
      covers.append(CGRect(x: 0, y: screen.minY, width: screen.width, height: bottom - screen.minY))
    }
    return covers
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
