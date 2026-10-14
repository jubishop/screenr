import Foundation
import Sentry
import Testing

@testable import ScreenrKit

struct TelemetryTests {
  private enum Failure: Error {
    case noResults(query: String)
  }

  private let capture = SentryEnvelopeCapture()
  private let router = LogRouter()

  private func telemetry(_ variant: AppConfiguration.Variant, roll: Double = 0.99) -> Telemetry {
    Telemetry(variant: variant, router: router, sessionRoll: roll, start: capture.start)
  }

  // A screen read whose route still holds a username and a search, which Telemetry reduces in
  // case a caller passes a raw path.
  private static func screenRequest(
    status: Int?,
    error: APIError.Kind? = nil
  ) -> APIRequestRecord {
    var failure: APIError?
    if let error {
      failure = APIError(kind: error, requestID: "3f2a9c")
    }
    return APIRequestRecord(
      method: "GET",
      route: "/api/screenr/screen?path=%2Fpeople%2Falice&q=dune",
      requestID: "3f2a9c",
      status: status,
      duration: .milliseconds(120),
      error: failure
    )
  }

  @Test func sendsAnErrorEventWithNoPersonalDataContentOrScreenshot() async throws {
    defer { capture.close() }
    let telemetry = telemetry(.release)
    telemetry.signIn(userID: "user-7f3a")
    // Data that must never leave the device, planted where Sentry would otherwise send it.
    capture.configureScope { scope in
      let user = User(userId: "user-7f3a")
      user.email = "alice@example.com"
      user.username = "alice"
      user.name = "Alice Smith"
      user.ipAddress = "203.0.113.7"
      scope.setUser(user)
      scope.setContext(value: ["name": "Alice's iPhone", "model": "iPhone18,1"], key: "device")
      // The scope's own breadcrumbs skip beforeBreadcrumb, so beforeSend must clean them.
      scope.addBreadcrumb(
        makeBreadcrumb("ui.lifecycle", ["screen": "ProfileView", "title": "Alice Smith"])
      )
      scope.addBreadcrumb(
        makeBreadcrumb(
          "http",
          [
            "url": "https://screenr.club/search?q=dune",
            "http.query": "q=dune",
            "method": "GET",
            "status_code": 200,
          ]
        )
      )
    }
    capture.addBreadcrumb(category: "touch", data: ["title": "Alice Smith", "view": "Button"])
    telemetry.requestFinished(Self.screenRequest(status: 503))

    telemetry.capture(Failure.noResults(query: "dune"), requestID: "3f2a9c")

    // Attachments travel in the event's envelope, so they have arrived with it.
    let items = try await capture.items { items in items.contains { $0.type == "event" } }
    #expect(capture.starts == 1)
    #expect(items.filter { $0.type == "attachment" }.isEmpty)
    let event = try #require(items.filter { $0.type == "event" }.only)
    let json = try event.json
    #expect(json["user"] as? [String: String] == ["id": "user-7f3a"])
    #expect((json["tags"] as? [String: String])?["request_id"] == "3f2a9c")
    let crumbs = try #require(json["breadcrumbs"] as? [[String: Any]])
    let urls = crumbs.compactMap { ($0["data"] as? [String: Any])?["url"] as? String }
    #expect(urls.contains("https://screenr.club/search"))
    #expect(urls.contains("/api/screenr/screen?path=/people/:username"))
    for leak in [
      "alice@example.com", "Alice Smith", "Alice's iPhone", "203.0.113.7", "ip_address",
      "\"email\"", "\"username\"", "dune", "alice", "q=",
    ] {
      #expect(!event.text.contains(leak), "The event contains \(leak).")
    }
  }

  @Test func devBuildsStartNoSentryAndSendNothing() throws {
    defer { capture.close() }
    let telemetry = telemetry(.dev, roll: 0)

    telemetry.signIn(userID: "user-7f3a")
    telemetry.requestFinished(Self.screenRequest(status: 503))
    Log(.app, router: router).fault("Broken")
    telemetry.capture(Failure.noResults(query: "dune"), requestID: "3f2a9c")
    telemetry.signOut()

    #expect(telemetry.state == .off)
    #expect(capture.starts == 0)
    #expect(try capture.items().isEmpty)
  }

  @Test func devConfigurationLeavesTheSentrySDKStopped() throws {
    let configuration = try AppConfiguration(infoDictionary: [
      "ScreenrVariant": "dev",
      "ScreenrServerURL": "http://localhost:3000",
      "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
      "ScreenrGoogleClientID": "1083-abc.apps.googleusercontent.com",
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
    ])

    let telemetry = Telemetry(configuration: configuration, router: router)

    #expect(telemetry.state == .off)
    #expect(!SentrySDK.isEnabled)
  }

  @Test func setsOnlyTheOpaqueUserIDAndClearsItOnSignOut() async throws {
    defer { capture.close() }
    let telemetry = telemetry(.release)

    telemetry.signIn(userID: "user-7f3a")
    telemetry.capture(Failure.noResults(query: "one"), requestID: "signed-in")
    telemetry.signOut()
    telemetry.capture(Failure.noResults(query: "two"), requestID: "signed-out")

    let events = try await capture.items(ofType: "event", count: 2).map { try $0.json }
    let byRequest = Dictionary(
      events.map { (($0["tags"] as? [String: String])?["request_id"] ?? "", $0) },
      uniquingKeysWith: { first, _ in first }
    )
    #expect(byRequest["signed-in"]?["user"] as? [String: String] == ["id": "user-7f3a"])
    #expect(byRequest["signed-out"]?["user"] == nil)
  }

  @Test func tracesEachAPICallUnderItsRouteAndRequestID() async throws {
    defer { capture.close() }
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = telemetry(.release, roll: 0)

    telemetry.requestFinished(Self.screenRequest(status: 200))

    let transaction = try #require(try await capture.items(ofType: "transaction", count: 1).only)
    let json = try transaction.json
    #expect(
      json["transaction"] as? String == "GET /api/screenr/screen?path=/people/:username"
    )
    let trace = (json["contexts"] as? [String: Any])?["trace"] as? [String: Any]
    #expect(trace?["op"] as? String == "http.client")
    #expect(trace?["status"] as? String == "ok")
    #expect((json["tags"] as? [String: String])?["request_id"] == "3f2a9c")
    let start = try #require(json["start_timestamp"] as? Double)
    let end = try #require(json["timestamp"] as? Double)
    #expect(abs(end - start - 0.12) < 0.05)
    #expect(!transaction.text.contains("alice"))
    #expect(!transaction.text.contains("dune"))
    let line = try #require(sink.entries.filter { $0.category == .api }.only)
    #expect(line.category == .api)
    #expect(line.level == .info)
    #expect(
      line.text
        == "Request finished method=GET"
        + " route=/api/screenr/screen?path=/people/:username"
        + " request_id=3f2a9c status=200 duration_ms=120.0"
    )
  }

  @Test func logsAFailedCallAsAWarningAndACancelledOneAsInfo() throws {
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = telemetry(.dev)

    telemetry.requestFinished(Self.screenRequest(status: nil, error: .offline))
    telemetry.requestFinished(Self.screenRequest(status: nil, error: .cancelled))

    let lines = sink.entries.filter { $0.category == .api }
    #expect(lines.map(\.level) == [.warning, .info])
    #expect(
      lines.map { $0.fields.first { $0.name == "outcome" }?.value }
        == [.string("failed"), .string("cancelled")]
    )
  }

  @Test(arguments: [0.0, 0.19])
  func tracesTheAPICallsOfOneSessionInFive(roll: Double) async throws {
    defer { capture.close() }
    let telemetry = telemetry(.release, roll: roll)

    telemetry.requestFinished(Self.screenRequest(status: 200))

    #expect(try await capture.items(ofType: "transaction", count: 1).count == 1)
  }

  // Sentry decides not to sample a transaction when it starts, before it queues anything, so the
  // flush shows that nothing was sent.
  @Test(arguments: [0.2, 0.99])
  func leavesTheOtherSessionsUntraced(roll: Double) throws {
    defer { capture.close() }
    let telemetry = telemetry(.release, roll: roll)

    telemetry.requestFinished(Self.screenRequest(status: 200))

    #expect(try capture.items(ofType: "transaction").isEmpty)
  }

  @Test func sendsWarningsAndAboveToSentryLogs() async throws {
    defer { capture.close() }
    let telemetry = telemetry(.release)
    let log = Log(.api, router: router)

    log.info("Loaded")
    log.notice("Noticed")
    log.warning("Slow", .int("status", 503))
    log.error("Failed")
    log.fault("Broken")

    #expect(telemetry.state == .reporting)
    let logs = try Self.logs(
      in: await capture.items { items in try Self.logs(in: items).count >= 3 }
    )
    #expect(logs.map { $0["body"] as? String } == ["Slow", "Failed", "Broken"])
    #expect(logs.map { $0["level"] as? String } == ["warn", "error", "fatal"])
    let attributes = try #require(logs.first?["attributes"] as? [String: [String: Any]])
    #expect(attributes["category"]?["value"] as? String == "api")
    #expect(attributes["status"]?["value"] as? Int == 503)
  }

  @Test func sendsTracesOfAppLaunchAndAPICallsOnly() {
    let options = Telemetry.options(traced: true)

    #expect(options.dsn == Telemetry.releaseDSN)
    #expect(options.enableAutoPerformanceTracing)
    #expect(!options.enableNetworkTracking)
    #expect(!options.enableFileIOTracing)
    #expect(!options.enableCoreDataTracing)
    #expect(options.configureProfiling == nil)
    // These options exist only where UIKit does, so the Simulator run checks them.
    #if canImport(UIKit)
    #expect(options.enableStandaloneAppStartTracing)
    #expect(!options.enableUIViewControllerTracing)
    #expect(!options.enableUserInteractionTracing)
    #endif
  }

  @Test func turnsOffPersonalDataAndCapturesAndTurnsOnHangsAndMetricKit() {
    let options = Telemetry.options(traced: false)

    #expect(!options.sendDefaultPii)
    #expect(!options.enableNetworkBreadcrumbs)
    #expect(!options.enableCaptureFailedRequests)
    #expect(options.enableAppHangTracking)
    #expect(options.enableMetricKit)
    #expect(options.enableLogs)
    #if canImport(UIKit)
    #expect(!options.attachScreenshot)
    #expect(!options.attachViewHierarchy)
    #expect(!options.reportAccessibilityIdentifier)
    #expect(options.sessionReplay.sessionSampleRate == 0)
    #expect(options.sessionReplay.onErrorSampleRate == 0)
    #endif
  }

  // The log entries in every log item, in the order Sentry sent them.
  private static func logs(in items: [SentryEnvelopeCapture.Item]) throws -> [[String: Any]] {
    try items.filter { $0.type == "log" }
      .flatMap { item in
        try item.json["items"] as? [[String: Any]] ?? []
      }
  }
}
