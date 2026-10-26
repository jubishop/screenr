import Foundation
import XCTest

// The top 10 editor that Edit opens on the You tab, against the fixture API,
// where Alice ranks Night Crossing, Paper Lanterns, and Harbor Lights.
// Dragging a row's handle sends one move with its new rank, a refused move
// returns the rows to their order with the reason, and swiping a row removes
// it. The profile reads back unchanged after a write, so each write is
// checked in the request log.
final class TopTenEditorTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // Dragging Harbor Lights above Night Crossing ranks it #1 with one move.
  @MainActor
  func testReordersByDraggingAHandle() throws {
    let log = RequestLog.temporary()
    let app = openEditor(log: log)
    try app.performSettingsAudit()

    app.drag("#3 Harbor Lights", onto: "#1 Night Crossing")

    wait(for: [log.wrote("top-ten", #"{"change":"move","rank":1,"title":"tv:201"}"#)], timeout: 10)
    XCTAssertEqual(
      app.editorOrder(),
      ["#1 Harbor Lights", "#2 Night Crossing", "#3 Paper Lanterns"]
    )
    XCTAssertEqual(try log.loggedLines().filter { $0.hasPrefix("POST") }.count, 1)
  }

  // A move the server refuses returns the rows to their order with the
  // reason.
  @MainActor
  func testRollsBackAFailedMove() throws {
    let log = RequestLog.temporary()
    let app = openEditor(log: log, overrides: ["actions/top-ten/move-unlisted"])

    app.drag("#3 Harbor Lights", onto: "#1 Night Crossing")

    XCTAssertTrue(
      app.staticTexts["That title is not in your top 10."].waitForExistence(timeout: 10)
    )
    XCTAssertEqual(
      app.editorOrder(),
      ["#1 Night Crossing", "#2 Paper Lanterns", "#3 Harbor Lights"]
    )
    XCTAssertEqual(
      try log.loggedLines().filter { $0.hasPrefix("POST") },
      [#"POST /api/screenr/top-ten {"change":"move","rank":1,"title":"tv:201"}"#]
    )
    try app.performSettingsAudit()
  }

  // Swiping Paper Lanterns offers Remove, which takes it out of the list, and
  // Harbor Lights moves up.
  @MainActor
  func testRemovesBySwiping() throws {
    let log = RequestLog.temporary()
    let app = openEditor(log: log)

    app.editorRow("#2 Paper Lanterns").swipeLeft()
    let remove = app.collectionViews.firstMatch.buttons["Remove"]
    XCTAssertTrue(remove.waitForExistence(timeout: 5))
    remove.tap()

    wait(for: [log.wrote("top-ten", #"{"change":"remove","title":"movie:102"}"#)], timeout: 10)
    XCTAssertEqual(app.editorOrder(), ["#1 Night Crossing", "#2 Harbor Lights"])
  }

  // VoiceOver reads each entry, which offers its actions, then the entry's
  // handle, which it drags with the list's own reorder gesture.
  @MainActor
  func testVoiceOverReadsEachEntryAndItsHandle() throws {
    let log = RequestLog.temporary()
    _ = openEditor(log: log)
    let voiceOver = XCUIDevice.shared.voiceOverService
    try voiceOver.enable()
    addTeardownBlock { @MainActor in
      do {
        try voiceOver.disable()
      } catch {
        XCTFail("VoiceOver did not stop: \(error)")
      }
    }

    var spoken: [String] = []
    while spoken.count < 12, !(spoken.last ?? "").hasPrefix("Reorder #3 Harbor Lights") {
      spoken.append(try voiceOver.moveForward().utterance)
    }

    for name in ["#1 Night Crossing", "#2 Paper Lanterns", "#3 Harbor Lights"] {
      let entry = try XCTUnwrap(spoken.firstIndex { $0.hasPrefix(name) }, name)
      XCTAssertTrue(spoken[entry].contains("Actions available"), spoken[entry])
      let handle = spoken.dropFirst(entry + 1).first ?? ""
      XCTAssertTrue(handle.hasPrefix("Reorder \(name) Button Draggable"), handle)
    }
  }

  // At the largest accessibility text size, every row's handle and the
  // explanation beneath them can be reached.
  @MainActor
  func testFitsTheLargestTextSize() throws {
    let app = openEditor(
      log: RequestLog.temporary(),
      textSize: "UICTContentSizeCategoryAccessibilityXXXL"
    )
    let list = app.collectionViews.firstMatch
    XCTAssertTrue(list.buttons["Reorder #1 Night Crossing"].isHittable)
    app.scrollTo(list.buttons["Reorder #3 Harbor Lights"])
    app.scrollTo(
      list.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Drag a title'")).firstMatch
    )
  }

  // Opens Alice's top 10 editor from Edit on her profile, the You tab's root.
  @MainActor
  private func openEditor(
    log: RequestLog,
    overrides: [String] = [],
    textSize: String? = nil
  ) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(overrides: overrides, requestLog: log.file, textSize: textSize))
    XCTAssertTrue(app.tab("You").waitForExistence(timeout: 10))
    app.tab("You").tap()
    let edit = app.buttons["Edit"]
    XCTAssertTrue(edit.waitForExistence(timeout: 10))
    if textSize != nil { app.scrollTo(edit) }
    edit.tap()
    XCTAssertTrue(app.navigationBars["Edit top 10"].waitForExistence(timeout: 10))
    return app
  }
}

extension XCUIApplication {
  // A row in the top 10 editor, by its label, such as "#1 Night Crossing".
  fileprivate func editorRow(_ label: String) -> XCUIElement {
    collectionViews.firstMatch.cells.containing(NSPredicate(format: "label == %@", label))
      .firstMatch
  }

  // The editor's rows, top to bottom.
  fileprivate func editorOrder() -> [String] {
    let rows = collectionViews.firstMatch.descendants(matching: .any)
      .matching(NSPredicate(format: "label MATCHES '#[0-9]+ .+'"))
      .allElementsBoundByIndex
    return rows.sorted { $0.frame.minY < $1.frame.minY }.map(\.label)
  }

  // Drags a row by its reorder handle onto another row's place.
  fileprivate func drag(_ label: String, onto target: String) {
    collectionViews.firstMatch.buttons["Reorder \(label)"]
      .press(forDuration: 0.5, thenDragTo: editorRow(target))
  }
}
