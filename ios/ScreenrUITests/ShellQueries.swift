import Foundation
import XCTest

extension XCUIAccessibilityAuditType {
  // The checks Screenr's audits run: contrast, Dynamic Type, clipped text, and
  // hit regions. Element descriptions, traits, actions, parent-child
  // relationships, and element detection go unchecked.
  static let screenr: XCUIAccessibilityAuditType = [
    .contrast, .dynamicType, .textClipped, .hitRegion,
  ]
}

extension XCUIApplication {
  func tab(_ name: String) -> XCUIElement {
    tabBars.buttons[name]
  }

  // The open confirmation dialog. iOS 27 shows one as a popover without
  // Cancel, at the control that asked or at the top of the screen, or, for a
  // dialog that a whole screen presents, sometimes as a sheet with Cancel in
  // the middle of the screen. Runs of the same test have seen all three.
  // Use it once the dialog shows.
  var openDialog: XCUIElement {
    popovers.firstMatch.exists ? popovers.firstMatch : sheets.firstMatch
  }

  // A button in the open confirmation dialog, such as "Decline".
  func confirmationButton(_ label: String) -> XCUIElement {
    openDialog.buttons[label]
  }

  // Closes the open confirmation dialog without its action: with Cancel when
  // it has one, or else with a tap outside it, above or below it, wherever
  // there is more room.
  func cancelConfirmation() {
    let dialog = openDialog
    let cancel = dialog.buttons["Cancel"]
    if cancel.exists {
      cancel.tap()
      return
    }
    let region = otherElements["PopoverDismissRegion"]
    let screen = region.frame
    let frame = dialog.frame
    let y =
      frame.minY - screen.minY > screen.maxY - frame.maxY
      ? (screen.minY + frame.minY) / 2 : (frame.maxY + screen.maxY) / 2
    region.coordinate(withNormalizedOffset: .zero)
      .withOffset(CGVector(dx: screen.width / 2, dy: y - screen.minY))
      .tap()
  }

  // Runs the accessibility audit one check at a time, passing over the
  // issues that `handler` accepts. In the iOS 27 Simulator, while another
  // Simulator ran UI tests, an audit of several checks at once sometimes
  // never finished, even at a modest load, and failed with "Audit failed to
  // complete in time", as did an audit of the same screen right after it.
  // Audits of one check each finished every time. Use it in place of
  // `performAccessibilityAudit(for:_:)`.
  func performScreenrAudit(
    for types: XCUIAccessibilityAuditType = .screenr,
    _ handler: ((XCUIAccessibilityAuditIssue) throws -> Bool)? = nil
  ) throws {
    // Clipped text and Dynamic Type go last, since both can move what the
    // other checks measure: the clipped-text check can scroll a scroll view
    // to bring cut-off text into view, and changing the text size can scroll
    // a list. On a title page scrolled by hand, a contrast check right after
    // the clipped-text check's scroll never finished in the iOS 27
    // Simulator, at any load.
    let checks: [XCUIAccessibilityAuditType] = [.hitRegion, .contrast, .textClipped, .dynamicType]
    for check in checks where types.contains(check) {
      try performAccessibilityAudit(for: check, handler)
    }
    let others = types.subtracting(.screenr)
    if !others.isEmpty {
      try performAccessibilityAudit(for: others, handler)
    }
  }

  // The accessibility audit for screens in the tabs. It passes over two
  // things the system sizes: navigation bars keep the wordmark's size, as
  // they do their titles, and the large content viewer shows it larger; and
  // the audit flags the system's search field, and on Find the text in it, as
  // clipping at large text sizes. It also passes over what it cannot measure
  // in a scrolling screen: the contrast and clipping of text beneath the glass
  // bars or the keyboard or past the screen's edges, and Dynamic Type for
  // scrolling content, which larger text moves past the screen's ends. Launch
  // with `FixtureLaunch(textSize:)` to audit a screen at the largest text size
  // instead. `types` narrows the checks, as for a screen where one hangs.
  func performShellAudit(for types: XCUIAccessibilityAuditType = .screenr) throws {
    try performSettledAudit(for: types) {
      let screen = windows.firstMatch.frame
      // Content also scrolls beneath the tab bar.
      var covers = glassCovers()
      if tabBars.firstMatch.exists {
        let top = tabBars.firstMatch.frame.minY
        covers.append(CGRect(x: 0, y: top, width: screen.width, height: screen.maxY - top))
      }
      // A list is a collection view, which scrolls like a scroll view.
      let scrolling = [scrollViews.firstMatch, collectionViews.firstMatch].filter(\.exists)
        .reduce(CGRect.null) { $0.union($1.frame) }
      let isCovered = { (frame: CGRect) in
        !screen.contains(frame) || covers.contains { $0.intersects(frame) }
      }
      // An issue without an element is one the audit cannot place: a part of a
      // list row without an element of its own, or text that a cover or the
      // screen's edge cuts off, such as the next poster in a row that scrolls
      // sideways. It counts as covered while any row or control in the content
      // reaches beneath a cover or past the screen's edge, and as
      // scrolling in a screen that scrolls. One snapshot finds the rows and
      // controls, since querying elements while the audit runs can outlast it.
      let partsCovered = Self.contentParts(in: try snapshot()).contains { isCovered($0.frame) }
      // While Find's search field holds text, and only then, the clipped-text
      // check also reports one issue it ties to no element, at every text
      // size, though nothing in the app's content clips: the field's text,
      // which the check flags as it flags the field itself. The audit passes
      // over that one issue on Find alone. A second, an issue with an element
      // in the content, or one while the field is empty still fails.
      let find = searchFields["Search movies and TV shows"]
      var unplacedSearchClips = 0
      if find.exists, let value = find.value as? String, !value.isEmpty,
        value != find.placeholderValue
      {
        unplacedSearchClips = 1
      }
      // An avatar's initial is one letter in a square frame that the avatar
      // clips to a circle. The contrast check samples the whole square, and
      // the page's color in its corners can outweigh a thin letter: on
      // 2026-11-09 a T covered 2.5% of an avatar and the white corners 21%,
      // and the check failed it, though the letter's own contrast with the
      // avatar's color is about 16:1.
      let isAvatarInitial = { (element: XCUIElement) in
        element.label.count == 1 && element.frame.width == element.frame.height
      }
      return { issue in
        var covered = partsCovered
        var scrolls = !scrolling.isNull
        if let frame = issue.element?.frame {
          covered = isCovered(frame)
          scrolls = scrolling.contains(frame)
        }
        switch issue.auditType {
        case .dynamicType:
          return issue.element?.label == "screenr" || scrolls
        case .textClipped:
          if issue.element?.elementType == .searchField || covered { return true }
          guard issue.element == nil, unplacedSearchClips > 0 else { return false }
          unplacedSearchClips -= 1
          return true
        case .contrast:
          if let element = issue.element, isAvatarInitial(element) { return true }
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
    for types: XCUIAccessibilityAuditType = .screenr,
    expecting: () throws -> (XCUIAccessibilityAuditIssue) -> Bool
  ) throws {
    var failed = false
    do {
      let isExpected = try expecting()
      try performScreenrAudit(for: types) { issue in
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
      let isExpected = try expecting()
      try performScreenrAudit(for: types) { issue in isExpected(issue) }
    }
  }

  // The list rows and controls in a screen's content, apart from the bars and
  // the keyboard that cover it.
  private static func contentParts(
    in snapshot: any XCUIElementSnapshot
  ) -> [any XCUIElementSnapshot] {
    let covers: [XCUIElement.ElementType] = [.navigationBar, .tabBar, .keyboard]
    guard !covers.contains(snapshot.elementType) else { return [] }
    let inner = snapshot.children.flatMap { contentParts(in: $0) }
    return [.cell, .button].contains(snapshot.elementType) ? [snapshot] + inner : inner
  }

  // The parts of the screen that content scrolls beneath, the status and
  // navigation bars, the keyboard, and the floating New activity control,
  // whose glass hides text from the audit's contrast check. The control's own
  // label sits on that glass too; check it with `labelContrast()`. A sheet's
  // navigation bar sits below the status bar, so a navigation bar covers the
  // screen from its top down to the bar's bottom. A bar behind a sheet covers
  // nothing the audit reaches, and can reach below the sheet's own bar, so
  // only bars in front count.
  func glassCovers() -> [CGRect] {
    let screen = windows.firstMatch.frame
    var covers = [keyboards.firstMatch].filter(\.exists).map(\.frame)
    for bar in navigationBars.allElementsBoundByIndex where bar.exists && bar.isHittable {
      let bottom = bar.frame.maxY
      covers.append(CGRect(x: 0, y: screen.minY, width: screen.width, height: bottom - screen.minY))
    }
    let floating = buttons.matching(identifier: "incoming-activity").allElementsBoundByIndex
    covers += floating.filter(\.exists).map(\.frame)
    return covers
  }
}

// A member path without the window that a paged friends feed's or profile's
// read names, such as `/` for `/?before=now`.
func withoutWindow(_ path: String) -> String {
  let pathname = path.prefix { $0 != "?" }
  let pairs = path.dropFirst(pathname.count + 1).split(separator: "&")
  let kept = pairs.filter { pair in
    let name = pair.prefix { $0 != "=" }
    return name != "since" && name != "before"
  }
  return kept.isEmpty ? String(pathname) : pathname + "?" + kept.joined(separator: "&")
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
    // The member path as sent, with a paged read's window.
    let sent: String
    // Words after the request, such as `visit`.
    let marks: ArraySlice<Substring>

    // The member path without the window that a paged feed's or profile's
    // read names, so `/` names every read of the friends feed.
    var path: String { withoutWindow(sent) }
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
        return ScreenRead(sent: path, marks: words.dropFirst(2))
      }
  }

  // The member path of each screen the app read, in order, without a paged
  // read's window.
  func screenPaths() throws -> [String] {
    try screenReads().map(\.path)
  }

  // Each screen read's member path as the app sent it, window and all.
  func sentScreenPaths() throws -> [String] {
    try screenReads().map(\.sent)
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

  // Fulfilled once the log has `line`, such as a write with its body.
  func logged(_ line: String) -> XCTestExpectation {
    logged { $0 == line }
  }

  // Fulfilled once the log has a line that `matches`.
  func logged(where matches: @escaping @Sendable (String) -> Bool) -> XCTestExpectation {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          return try loggedLines().contains(where: matches)
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
