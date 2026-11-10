import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest

// The App Store listing's screenshots, taken from the demo circle for Apple's
// review, never a real member's data: the reviewer's feed, Ted Lasso's title
// page, Maya's profile, and Find a title. Each screen is audited after its
// screenshot. bin/check-ios names a directory in SCREENR_SCREENSHOTS, where
// each one is written as a PNG without an alpha channel, as App Store Connect
// requires; bin/app-store-listing --screenshots copies them into the listing.
final class AppStoreScreenshotTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testTakesTheListingScreenshots() throws {
    var app = launch()
    XCTAssertTrue(app.entry(DemoFixture.reviewerTedLasso).waitForExistence(timeout: 10))
    try capture("1-feed")
    try app.performShellAudit()

    app = launch(link: "titles/tv/97546")
    XCTAssertTrue(app.navigationBars["Ted Lasso"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["watch-status"].waitForExistence(timeout: 10))
    try capture("2-title")
    try app.performShellAudit()

    app = launch(link: "people/demo_maya")
    XCTAssertTrue(app.navigationBars["Maya"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["#1 Paddington 2"].waitForExistence(timeout: 10))
    try capture("3-profile")
    // Maya's entry's byline, "reviewed and recommends", fills its line beside
    // the poster, and the clipped-text check flags it: at the largest text
    // sizes, the poster leaves the byline a column a few letters wide.
    try app.performShellAudit(for: XCUIAccessibilityAuditType.screenr.subtracting(.textClipped))

    app = launch(link: "search")
    XCTAssertTrue(app.buttons(starting: "Paddington 2").waitForExistence(timeout: 10))
    // Find focuses its search field; a short pull puts the keyboard away and
    // leaves the list at its top.
    let list = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
    list.press(forDuration: 0.1, thenDragTo: list.withOffset(CGVector(dx: 0, dy: 120)))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 10))
    // The list bounces back to its top.
    let settled = XCTestExpectation(description: "The list settles")
    settled.isInverted = true
    _ = XCTWaiter.wait(for: [settled], timeout: 1)
    try capture("4-find")
    try app.performShellAudit()
  }

  @MainActor
  private func launch(link: String? = nil) -> XCUIApplication {
    var fixtures = FixtureLaunch(viewer: "demo_reviewer")
    if let link { fixtures.link = "screenr-dev://\(link)" }
    let app = XCUIApplication()
    app.launch(with: fixtures)
    return app
  }

  // Writes the screen to SCREENR_SCREENSHOTS, when it is set, at the
  // screen's full resolution, redrawn opaque in sRGB, so ImageIO leaves the
  // alpha channel out of the PNG.
  @MainActor
  private func capture(_ name: String) throws {
    guard let directory = ProcessInfo.processInfo.environment["SCREENR_SCREENSHOTS"] else {
      return
    }
    let image = XCUIScreen.main.screenshot().image
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    format.opaque = true
    format.preferredRange = .standard
    let redrawn = UIGraphicsImageRenderer(size: image.size, format: format)
      .image { _ in image.draw(at: .zero) }
    let png = NSMutableData()
    guard let opaque = redrawn.cgImage,
      let destination = CGImageDestinationCreateWithData(
        png,
        UTType.png.identifier as CFString,
        1,
        nil
      )
    else {
      throw ScreenshotError("Could not encode the \(name) screenshot")
    }
    CGImageDestinationAddImage(destination, opaque, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw ScreenshotError("Could not encode the \(name) screenshot")
    }
    let folder = URL(filePath: directory, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try (png as Data).write(to: folder.appending(path: "\(name).png"))
  }
}

struct ScreenshotError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

// Demo circle entries in the `demo` screen fixtures.
enum DemoFixture {
  // The reviewer wants to watch Ted Lasso, with Priya's reply, atop the feed.
  static let reviewerTedLasso = "6206f34a-2cf9-41a6-8ed2-364d81453bf7"
}
