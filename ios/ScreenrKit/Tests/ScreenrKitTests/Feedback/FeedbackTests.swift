import Foundation
import ImageIO
import Synchronization
import Testing
import UniformTypeIdentifiers

@testable import ScreenrKit

// The Send feedback form: what it attaches, what it sends, and the Sentry user feedback envelope
// that Release builds send, read from a local transport.
@MainActor
struct FeedbackTests {
  private let directory = TemporaryDirectory()

  @Test func sendsSentryUserFeedbackWithScreenshotsLogTailsAndOnlyTheUserID() async throws {
    let capture = SentryEnvelopeCapture()
    defer {
      capture.close()
      directory.remove()
    }
    let router = LogRouter()
    let telemetry = Telemetry(
      variant: .release,
      version: "1.0",
      build: "7",
      router: router,
      sessionRoll: 0.99,
      start: capture.start
    )
    telemetry.signIn(userID: "user-7f3a")
    let logFile = LogFile(directory: directory.url, name: "app")
    router.add(logFile)
    Log(.api, router: router).info("Request finished", .int("status", 200))
    let sender: any FeedbackSender = try #require(telemetry.feedback)
    let model = FeedbackModel(service: FeedbackService(sender: sender, logFile: logFile))
    model.message = "  The poster on the title page is cut off.\n"
    await model.attach([{ try Self.screenshot(width: 1206, height: 2622) }])
    let screenshot = try #require(model.screenshots.only).jpeg

    await model.send()

    #expect(model.phase == .sent)
    let items = try await capture.items { items in
      items.contains { $0.type == "feedback" } && items.count { $0.type == "attachment" } >= 2
    }
    let feedback = try #require(items.filter { $0.type == "feedback" }.only)
    let event = try feedback.json
    #expect(event["user"] as? [String: String] == ["id": "user-7f3a"])
    let contexts = try #require(event["contexts"] as? [String: Any])
    let context = try #require(contexts["feedback"] as? [String: Any])
    #expect(Set(context.keys) == ["message", "source"])
    #expect(context["message"] as? String == "The poster on the title page is cut off.")
    #expect(context["source"] as? String == "custom")
    // The feedback issue workflow names the build by these.
    #expect(event["release"] as? String == "com.artisanalsoftware.Screenr@1.0+7")
    #expect(event["dist"] as? String == "7")
    for leak in ["\"email\"", "contact_email", "\"username\"", "ip_address"] {
      #expect(!feedback.text.contains(leak), "The feedback contains \(leak).")
    }

    let attachments = items.filter { $0.type == "attachment" }
    #expect(attachments.map(\.filename) == ["screenshot-1.jpg", "app.ndjson"])
    #expect(attachments.map(\.contentType) == ["image/jpeg", "application/x-ndjson"])
    #expect(attachments.first?.payload == screenshot)
    let tail = try #require(attachments.last).text
    #expect(tail.hasSuffix("\n"))
    #expect(tail.contains(#""message":"Request finished""#))
    #expect(tail.contains(#""status":200"#))
  }

  @Test func devBuildsHaveNoFeedbackSender() {
    let telemetry = Telemetry(
      variant: .dev,
      version: "1.0",
      build: "7",
      router: LogRouter(),
      sessionRoll: 0,
      start: { _ in preconditionFailure("Dev builds never start Sentry") }
    )
    let model = FeedbackModel(service: FeedbackService(sender: telemetry.feedback, logFile: nil))
    model.message = "Hello"

    #expect(telemetry.feedback == nil)
    #expect(model.availability == .unavailable)
    #expect(!model.canSend)
  }

  @Test func sendsTheTrimmedMessageScreenshotsAndEachLogsTail() async throws {
    defer { directory.remove() }
    let sender = RecordingFeedbackSender()
    let app = LogFile(directory: directory.url, name: "app")
    Log(.app, router: LogRouter(sinks: [app])).info("Launched")
    // Another process's log, such as the notification extension's.
    let notifications = LogFile(directory: directory.url, name: "notifications")
    Log(.push, router: LogRouter(sinks: [notifications])).info("Fetched")
    await notifications.flush()
    let model = FeedbackModel(service: FeedbackService(sender: sender, logFile: app))
    model.message = "\n Search misses some shows "
    await model.attach([
      { try Self.screenshot(width: 600, height: 1200) },
      { try Self.screenshot(width: 800, height: 400) },
    ])

    await model.send()

    let sent = try #require(sender.sent.only)
    #expect(sent.message == "Search misses some shows")
    #expect(sent.screenshots.count == 2)
    #expect(sent.logs.map(\.name) == ["app", "notifications"])
    #expect(String(decoding: sent.logs[0].data, as: UTF8.self).contains("Launched"))
    #expect(String(decoding: sent.logs[1].data, as: UTF8.self).contains("Fetched"))
    #expect(model.phase == .sent)
    #expect(model.message.isEmpty)
    #expect(model.screenshots.isEmpty)
    #expect(model.failure == nil)
  }

  @Test(arguments: ["", "  \n "])
  func waitsForAMessage(message: String) async {
    let sender = RecordingFeedbackSender()
    let model = FeedbackModel(service: FeedbackService(sender: sender, logFile: nil))
    model.message = message

    await model.send()

    #expect(model.availability == .available)
    #expect(!model.canSend)
    #expect(sender.sent.isEmpty)
    #expect(model.phase == .composing)
  }

  @Test func keepsTheDraftWhenSendingFails() async {
    let sender = RecordingFeedbackSender(failing: true)
    let model = FeedbackModel(service: FeedbackService(sender: sender, logFile: nil))
    model.message = "Replies are slow"

    await model.send()

    #expect(model.phase == .composing)
    #expect(model.message == "Replies are slow")
    #expect(model.failure == "Your feedback could not be sent. Try again.")
    #expect(model.canSend)
  }

  @Test func downscalesScreenshotsAndAttachesAtMostThree() async throws {
    let model = FeedbackModel(service: FeedbackService(sender: nil, logFile: nil))
    let load: @Sendable () async throws -> Data? = {
      try Self.screenshot(width: 1320, height: 2868)
    }

    await model.attach([load, load, load, load])

    #expect(model.screenshots.count == FeedbackModel.maximumScreenshots)
    #expect(model.remainingScreenshots == 0)
    #expect(model.failure == nil)
    for screenshot in model.screenshots {
      let source = try #require(CGImageSourceCreateWithData(screenshot.jpeg as CFData, nil))
      #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
      let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
      #expect(image.height == 2048)
      #expect(abs(image.width - 943) <= 1)
      #expect(screenshot.jpeg.count <= ScreenshotPreparation.limit)
    }

    let first = try #require(model.screenshots.first)
    model.remove(first.id)

    #expect(model.screenshots.count == 2)
    #expect(model.remainingScreenshots == 1)
  }

  // Noise compresses poorly, so the first attempts are over the limit.
  @Test func lowersTheSizeOrQualityUntilTheScreenshotFits() async throws {
    let noisy = try FixturePhoto.encode(
      FixturePhoto.image(width: 1500, height: 3000, noise: 120),
      quality: 1,
      type: .png
    )

    let jpeg = try await ScreenshotPreparation.jpeg(from: noisy)

    #expect(jpeg.count <= ScreenshotPreparation.limit)
  }

  @Test func dropsTheImagesMetadata() async throws {
    let located = try FixturePhoto.encode(
      FixturePhoto.image(width: 400, height: 800, noise: 0),
      quality: 0.9,
      properties: [
        kCGImagePropertyGPSDictionary: [
          kCGImagePropertyGPSLatitude: 37.77,
          kCGImagePropertyGPSLatitudeRef: "N",
          kCGImagePropertyGPSLongitude: 122.42,
          kCGImagePropertyGPSLongitudeRef: "W",
        ]
      ]
    )
    #expect(Self.properties(of: located)[kCGImagePropertyGPSDictionary as String] != nil)

    let jpeg = try await ScreenshotPreparation.jpeg(from: located)

    #expect(Self.properties(of: jpeg)[kCGImagePropertyGPSDictionary as String] == nil)
  }

  @Test func reportsScreenshotsThatCannotBeAttached() async {
    let model = FeedbackModel(service: FeedbackService(sender: nil, logFile: nil))

    await model.attach([{ nil }, { throw CocoaError(.fileReadCorruptFile) }])

    #expect(model.screenshots.isEmpty)
    #expect(model.failure == "2 screenshots could not be attached. Try others.")

    await model.attach([
      { Data("not an image".utf8) },
      { try Self.screenshot(width: 300, height: 600) },
    ])

    #expect(model.screenshots.count == 1)
    #expect(model.failure == "A screenshot could not be attached. Try another.")
    #expect(model.phase == .composing)
  }

  @Test func writesFeedbackToTheFixtureRequestLog() throws {
    defer { directory.remove() }
    try FileManager.default.createDirectory(at: directory.url, withIntermediateDirectories: true)
    let file = directory.url.appending(path: "requests.log")
    let transport = try FixtureTransport(
      directory: TestFixtures.directory,
      scenario: FixtureScenario(requestLog: file)
    )

    try transport.feedback.send(
      Feedback(
        message: "Posters load slowly",
        screenshots: [Data([1, 2, 3])],
        logs: [LogTail(name: "app", data: Data("{}\n".utf8))]
      )
    )

    #expect(
      try String(contentsOf: file, encoding: .utf8)
        == #"FEEDBACK {"logs":["app"],"message":"Posters load slowly","screenshots":1}"# + "\n"
    )
  }

  // A screenshot-like PNG.
  private nonisolated static func screenshot(width: Int, height: Int) throws -> Data {
    try FixturePhoto.encode(
      FixturePhoto.image(width: width, height: height, noise: 0),
      quality: 1,
      type: .png
    )
  }

  private static func properties(of data: Data) -> [String: Any] {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]
    else { return [:] }
    return properties
  }
}

// Keeps what the form sends, or fails every send.
final class RecordingFeedbackSender: FeedbackSender {
  struct Failure: Error {}

  private let failing: Bool
  private let reports = Mutex<[Feedback]>([])

  init(failing: Bool = false) {
    self.failing = failing
  }

  var sent: [Feedback] { reports.withLock { $0 } }

  func send(_ feedback: Feedback) throws {
    if failing { throw Failure() }
    reports.withLock { $0.append(feedback) }
  }
}
