import Foundation
import Sentry
import Testing

@testable import ScreenrKit

struct TelemetryTests {
  private enum Failure: Error {
    case noResults(query: String)
    case fixtureChanged
  }

  private let capture = SentryEnvelopeCapture()
  private let router = LogRouter()

  private func telemetry(_ variant: AppConfiguration.Variant, roll: Double = 0.99) -> Telemetry {
    Telemetry(
      variant: variant,
      version: "1.0",
      build: "7",
      router: router,
      sessionRoll: roll,
      start: capture.start
    )
  }

  // A screen read whose route still holds a username and a search, which Telemetry reduces in
  // case a caller passes a raw path.
  private static func screenRequest(
    status: Int?,
    error: APIError.Kind? = nil,
    trigger: RequestTrigger = .demand,
    requestID: String = "3f2a9c"
  ) -> APIRequestRecord {
    var failure: APIError?
    if let error {
      failure = APIError(kind: error, requestID: requestID)
    }
    return APIRequestRecord(
      method: "GET",
      route: "/api/screenr/screen?path=%2Fpeople%2Falice&q=dune",
      requestID: requestID,
      status: status,
      duration: .milliseconds(120),
      error: failure,
      trigger: trigger
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

  // Most 4xx answers are expected, such as not found or an ended session, so they log at info. A
  // 5xx, no response, or a response the app cannot use logs a warning, whatever its status. Each
  // failure names its error, and a cancelled call logs at info.
  @Test func logsA4xxAtInfoAndAnyOtherFailureAsAWarningWithItsError() throws {
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = telemetry(.dev)
    let calls: [(Int?, APIError.Kind)] = [
      (404, .notFound), (401, .signedOut), (503, .server(status: 503)), (nil, .offline),
      (200, .invalidResponse), (304, .invalidResponse), (200, .keychain), (200, .cancelled),
    ]

    for (status, error) in calls {
      telemetry.requestFinished(Self.screenRequest(status: status, error: error))
    }

    let lines = sink.entries.filter { $0.category == .api }
    #expect(
      lines.map(\.level)
        == [.info, .info, .warning, .warning, .warning, .warning, .warning, .info]
    )
    #expect(
      lines.map { $0.fields.first { $0.name == "outcome" }?.value }
        == Array(repeating: .string("failed"), count: 7) + [.string("cancelled")]
    )
    #expect(
      lines.map { $0.fields.first { $0.name == "error" }?.value }
        == [
          .string("notFound"), .string("signedOut"), .string("server"), .string("offline"),
          .string("invalidResponse"), .string("invalidResponse"), .string("keychain"), nil,
        ]
    )
    #expect(
      lines.map { $0.fields.first { $0.name == "status" }?.value }
        == [.int(404), .int(401), .int(503), nil, .int(200), .int(304), .int(200), .int(200)]
    )
  }

  // A 200 whose body no longer decodes, as when the server's payload drifts, is a failure. It logs
  // a warning with DecodingError's case and coding path but no value from the body, marks its
  // breadcrumb and trace as errors, and opens a Sentry issue, once per route in a launch.
  @MainActor
  @Test func reportsAnUndecodableResponseWithItsCauseButNoValue() async throws {
    defer { capture.close() }
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = telemetry(.release, roll: 0)
    let reply = try Self.undecodableFeed()
    let client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: try SessionStore(keychain: InMemoryKeychain(token: "signed-token")),
      transport: RecordingTransport([reply, reply]),
      observer: telemetry
    )

    for _ in 1...2 {
      let error = await #expect(throws: APIError.self) {
        try await client.send(.screen(path: "/"))
      }
      #expect(error?.kind == .invalidResponse)
    }

    let lines = sink.entries.filter { $0.category == .api }
    #expect(lines.map(\.level) == [.warning, .warning])
    let line = try #require(lines.first)
    #expect(
      line.fields.filter { !["request_id", "duration_ms"].contains($0.name) } == [
        LogField(name: "method", value: .string("GET")),
        LogField(name: "route", value: .string("/api/screenr/screen?path=/")),
        LogField(name: "status", value: .int(200)),
        LogField(name: "outcome", value: .string("failed")),
        LogField(name: "error", value: .string("invalidResponse")),
        LogField(name: "decoding", value: .string("dataCorrupted")),
        LogField(name: "coding_path", value: .string("conversations[1].activityAt")),
      ]
    )
    #expect(!line.text.contains("Alice"), "The line repeats the body: \(line.text)")
    let requestID = try #require(line.fields.first { $0.name == "request_id" }?.value)
    let items = try await capture.items { items in
      items.contains { $0.type == "event" } && items.count { $0.type == "transaction" } >= 2
    }
    let event = try #require(items.filter { $0.type == "event" }.only)
    let json = try event.json
    #expect((json["tags"] as? [String: String])?["request_id"] == requestID.description)
    let crumbs = try #require(json["breadcrumbs"] as? [[String: Any]])
    let crumb = try #require(crumbs.filter { $0["category"] as? String == "http" }.only)
    #expect(crumb["level"] as? String == "error")
    #expect(!event.text.contains("Alice"))
    let traces = try items.filter { $0.type == "transaction" }
      .map { item in ((try item.json["contexts"] as? [String: Any])?["trace"] as? [String: Any]) }
    #expect(traces.map { $0?["status"] as? String } == ["internal_error", "internal_error"])
    // The same route failing again in this launch logs and traces, but opens no second report.
    #expect(try capture.items(ofType: "event").count == 1)
  }

  // A live read's successful poll, changed or not, logs only at debug level, which the log file
  // leaves out, and adds nothing to Sentry. A poll that fails is recorded in full.
  @Test func recordsAPollInFullOnlyWhenItFails() async throws {
    defer { capture.close() }
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = telemetry(.release, roll: 0)

    for (status, error, requestID) in [
      (304, nil, "unchanged"), (200, nil, "changed"), (503, .server(status: 503), "server"),
      (nil, .offline, "offline"),
    ] as [(Int?, APIError.Kind?, String)] {
      telemetry.requestFinished(
        Self.screenRequest(status: status, error: error, trigger: .poll, requestID: requestID)
      )
    }
    telemetry.capture(Failure.noResults(query: "dune"), requestID: "after-polling")

    let lines = sink.entries.filter { $0.category == .api }
    #expect(lines.map(\.level) == [.debug, .debug, .warning, .warning])
    let items = try await capture.items { items in
      items.contains { $0.type == "event" } && items.count { $0.type == "transaction" } >= 2
    }
    let event = try #require(items.filter { $0.type == "event" }.only)
    let crumbs = try #require(try event.json["breadcrumbs"] as? [[String: Any]])
    let crumbRequests = crumbs.filter { $0["category"] as? String == "http" }
      .compactMap { ($0["data"] as? [String: Any])?["request_id"] as? String }
    #expect(crumbRequests == ["server", "offline"])
    let tracedRequests = try capture.items(ofType: "transaction")
      .compactMap { item in (try item.json["tags"] as? [String: String])?["request_id"] }
    #expect(tracedRequests.sorted() == ["offline", "server"])
  }

  // An open screen polls every three seconds, and an unchanged one gets a 304 each time. Once its
  // first read is recorded, a minute of polls adds no line to the log file and nothing to Sentry.
  @MainActor
  @Test(.timeLimit(.minutes(2)))
  func recordsAnUnchangedScreenOnlyOnItsFirstRead() async throws {
    defer { capture.close() }
    let directory = TemporaryDirectory()
    defer { directory.remove() }
    let file = LogFile(directory: directory.url, name: "app")
    let sink = CapturingSink()
    router.add(file)
    router.add(sink)
    let telemetry = telemetry(.release, roll: 0)
    let client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: try SessionStore(keychain: InMemoryKeychain(token: FixtureTransport.token)),
      transport: try FixtureTransport(directory: TestFixtures.directory),
      observer: telemetry
    )
    let clock = TestClock()
    let model = ScreenModel(path: "/", api: client, clock: clock)
    model.appeared(appActive: true)
    await clock.waitForSleep(until: .seconds(3))
    #expect(try await capture.items(ofType: "transaction", count: 1).count == 1)
    await file.flush()
    let firstReadLines = try Self.lineCount(of: file)

    for poll in 1...20 {
      clock.advance(by: .seconds(3))
      await clock.waitForSleep(until: .seconds(3 * (poll + 1)))
    }
    model.disappeared()
    telemetry.capture(Failure.noResults(query: "dune"), requestID: "after-polling")
    await file.flush()

    let statuses = sink.entries.filter { $0.category == .api }
      .map { entry in entry.fields.first { $0.name == "status" }?.value }
    #expect(statuses == [.int(200)] + Array(repeating: .int(304), count: 20))
    let pollingLines = try Self.lineCount(of: file)
    #expect(firstReadLines == 1)
    #expect(pollingLines == firstReadLines)
    let items = try await capture.items { items in items.contains { $0.type == "event" } }
    let event = try #require(items.filter { $0.type == "event" }.only)
    let crumbs = try #require(try event.json["breadcrumbs"] as? [[String: Any]])
    #expect(crumbs.count { $0["category"] as? String == "http" } == 1)
    let transactions = try capture.items(ofType: "transaction")
    #expect(transactions.count == 1)
  }

  // The share extension's telemetry logs its calls and reports nothing.
  @Test func localOnlyTelemetryLogsCallsWithoutSentry() {
    let sink = CapturingSink()
    router.add(sink)
    let telemetry = Telemetry.localOnly(router: router)

    telemetry.requestFinished(Self.screenRequest(status: 200))

    #expect(telemetry.state == .off)
    #expect(telemetry.feedback == nil)
    #expect(sink.entries.filter { $0.category == .api }.map(\.level) == [.info])
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
    let options = Telemetry.options(traced: true, version: "1.0", build: "7")

    #expect(options.dsn == Telemetry.releaseDSN)
    #expect(options.releaseName == "com.artisanalsoftware.Screenr@1.0+7")
    #expect(options.dist == "7")
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
    let options = Telemetry.options(traced: false, version: "1.0", build: "7")

    #expect(!options.sendDefaultPii)
    #expect(!options.enableNetworkBreadcrumbs)
    #expect(!options.enableCaptureFailedRequests)
    #expect(options.enableAppHangTracking)
    #expect(options.enableMetricKit)
    // MetricKit events carry iOS's raw diagnostic, whose call tree Sentry doesn't trim.
    #expect(options.enableMetricKitRawPayload)
    #expect(options.enableLogs)
    #if canImport(UIKit)
    #expect(!options.attachScreenshot)
    #expect(!options.attachViewHierarchy)
    #expect(!options.reportAccessibilityIdentifier)
    #expect(options.sessionReplay.sessionSampleRate == 0)
    #expect(options.sessionReplay.onErrorSampleRate == 0)
    #endif
  }

  // Alice's feed, with a timestamp that holds her name, which DecodingError's description repeats.
  private static func undecodableFeed() throws -> RecordingTransport.Reply {
    let feed = try JSONDecoder()
      .decode(
        JSONValue.self,
        from: try TestFixtures.body("screen/feed/default")
      )
    guard case .object(var body) = feed, case .array(var conversations)? = body["conversations"],
      conversations.count > 1, case .object(var conversation) = conversations[1]
    else { throw Failure.fixtureChanged }
    conversation["activity_at"] = "Alice Park's birthday"
    conversations[1] = .object(conversation)
    body["conversations"] = .array(conversations)
    return .response(status: 200, body: try JSONEncoder().encode(JSONValue.object(body)))
  }

  private static func lineCount(of file: LogFile) throws -> Int {
    try Data(contentsOf: file.currentURL).split(separator: 0x0A).count
  }

  // The log entries in every log item, in the order Sentry sent them.
  private static func logs(in items: [SentryEnvelopeCapture.Item]) throws -> [[String: Any]] {
    try items.filter { $0.type == "log" }
      .flatMap { item in
        try item.json["items"] as? [[String: Any]] ?? []
      }
  }
}
