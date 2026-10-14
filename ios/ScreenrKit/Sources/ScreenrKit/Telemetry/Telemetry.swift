import Foundation
import Sentry

// Crash, error, hang, and performance reporting through Sentry, which runs only in Release
// builds. Dev builds never start Sentry, so they send nothing. What Release builds send is
// pseudonymous and holds no member content: the user is the opaque Screenr user ID, URLs become
// route patterns, and SentryPrivacy checks every event, breadcrumb, span, and log line.
public final class Telemetry: APIRequestObserver {
  public enum State: String, Sendable, Equatable, CaseIterable {
    case off
    case reporting
  }

  // The screenr-ios project's DSN. It is public: every Release build contains it.
  static let releaseDSN =
    "https://7835b8d6ce485bae558bdc65d7f373ee@o4508469263663104.ingest.us.sentry.io/4512251383513088"
  // The share of sessions, that is, app launches, whose app launch and API calls are traced.
  static let tracedShare = 0.2
  // Only Release builds report, so the release name, like Sentry's default, starts with their
  // bundle ID.
  static let bundleID = "com.artisanalsoftware.Screenr"

  public let state: State
  private let reporter: (any SentryReporter)?
  private let api: Log

  public convenience init(configuration: AppConfiguration, router: LogRouter = .shared) {
    self.init(
      variant: configuration.variant,
      version: configuration.version,
      build: configuration.build,
      router: router,
      sessionRoll: Double.random(in: 0..<1),
      start: SentrySDKReporter.start
    )
  }

  // sessionRoll, from 0 up to 1, decides whether this session is traced.
  init(
    variant: AppConfiguration.Variant,
    version: String,
    build: String,
    router: LogRouter,
    sessionRoll: Double,
    start: (sending Options) -> any SentryReporter
  ) {
    api = Log(.api, router: router)
    switch variant {
    case .dev:
      reporter = nil
      state = .off
    case .release:
      let reporter = start(
        Self.options(traced: sessionRoll < Self.tracedShare, version: version, build: build)
      )
      router.add(SentryLogSink(reporter: reporter))
      self.reporter = reporter
      state = .reporting
    }
  }

  // Sets the signed-in member's opaque Screenr user ID as the Sentry user, with nothing else.
  public func signIn(userID: String) {
    reporter?.setUser(User(userId: userID))
  }

  // Clears the Sentry user. An empty user, rather than none, keeps Sentry from filling in its
  // installation ID; SentryPrivacy then sends the event with no user at all.
  public func signOut() {
    reporter?.setUser(User())
  }

  // Reports an error as a Sentry issue, tagged with the request ID of the API call behind it.
  public func capture(_ error: any Error, requestID: String? = nil) {
    var tags: [String: String] = [:]
    if let requestID { tags["request_id"] = requestID }
    reporter?.capture(error: error, tags: tags)
  }

  // Sends the Send feedback form's reports to Sentry, or nil in Dev builds, which send nothing.
  public var feedback: (any FeedbackSender)? {
    guard let reporter else { return nil }
    return SentryFeedbackSender(reporter: reporter)
  }

  // Logs a finished API call and adds it to Sentry as a breadcrumb and, in traced sessions, a
  // transaction, each tagged with its request ID. The API client reports every call here. Its
  // route is already a pattern; reducing it again keeps a raw path from reaching Sentry.
  public func requestFinished(_ record: APIRequestRecord) {
    let route = RoutePattern(path: record.route)
    var fields: [LogField] = [
      LogField(name: "method", value: .string(record.method)),
      .route(route),
      .identifier("request_id", record.requestID),
    ]
    let level: LogLevel
    let breadcrumbLevel: SentryLevel
    let spanStatus: SentrySpanStatus
    switch (record.status, record.error?.kind) {
    case (let status?, _):
      fields.append(.int("status", status))
      level = status >= 500 ? .warning : .info
      breadcrumbLevel = status >= 500 ? .error : status >= 400 ? .warning : .info
      spanStatus = Self.spanStatus(forHTTPStatus: status)
    case (nil, .cancelled?):
      fields.append(.constant("outcome", "cancelled"))
      level = .info
      breadcrumbLevel = .info
      spanStatus = .cancelled
    case (nil, _):
      fields.append(.constant("outcome", "failed"))
      level = .warning
      breadcrumbLevel = .error
      spanStatus = .unavailable
    }
    fields.append(.duration("duration_ms", record.duration))
    api.write(level, "Request finished", fields)

    guard let reporter else { return }
    let breadcrumb = Breadcrumb(level: breadcrumbLevel, category: "http")
    breadcrumb.type = "http"
    breadcrumb.setData(value: record.method, key: "method")
    breadcrumb.setData(value: route.value, key: "url")
    breadcrumb.setData(value: record.requestID, key: "request_id")
    breadcrumb.setData(value: record.duration.milliseconds, key: "duration_ms")
    breadcrumb.setData(value: record.status, key: "status_code")
    reporter.add(breadcrumb)

    let end = Date.now
    let start = end.addingTimeInterval(-record.duration.milliseconds / 1_000)
    let context = TransactionContext(
      name: "\(record.method) \(route.path)",
      operation: "http.client"
    )
    reporter.recordTransaction(context) { transaction in
      transaction.startTimestamp = start
      transaction.setTag(value: record.requestID, key: "request_id")
      transaction.setData(value: record.status, key: "http.response.status_code")
      transaction.finish(status: spanStatus)
    }
  }

  static func options(traced: Bool, version: String, build: String) -> Options {
    let options = Options()
    options.dsn = releaseDSN
    options.environment = "production"
    // The release and dist name the build, in Sentry's default form but from the build's
    // settings. The feedback issue workflow reads them.
    options.releaseName = "\(bundleID)@\(version)+\(build)"
    options.dist = build
    options.sendDefaultPii = false
    // Sentry's URLSession instrumentation would record full URLs and queries. Telemetry records
    // API calls itself, with route patterns.
    options.enableNetworkTracking = false
    options.enableNetworkBreadcrumbs = false
    options.enableCaptureFailedRequests = false
    options.enableGraphQLOperationTracking = false
    options.tracePropagationTargets = []
    options.enableAppHangTracking = true
    options.enableMetricKit = true
    options.enableLogs = true
    // Traces cover app launch and API calls, in one session of five.
    options.enableAutoPerformanceTracing = true
    options.enableFileIOTracing = false
    options.enableDataSwizzling = false
    options.enableFileManagerSwizzling = false
    options.enableCoreDataTracing = false
    options.enableTimeToFullDisplayTracing = false
    options.enableMetrics = false
    options.tracesSampler = { _ in NSNumber(value: traced ? 1 : 0) }
    #if canImport(UIKit)
    options.attachScreenshot = false
    options.attachViewHierarchy = false
    options.reportAccessibilityIdentifier = false
    options.sessionReplay.sessionSampleRate = 0
    options.sessionReplay.onErrorSampleRate = 0
    options.enableStandaloneAppStartTracing = true
    options.enableUIViewControllerTracing = false
    options.enableUserInteractionTracing = false
    #endif
    // Until sign-in, events have no user, as after sign-out.
    options.initialScope = { scope in
      scope.setUser(User())
      return scope
    }
    options.beforeSend = SentryPrivacy.scrub
    options.beforeBreadcrumb = SentryPrivacy.scrub
    options.beforeSendSpan = SentryPrivacy.scrub
    options.beforeSendLog = SentryPrivacy.scrub
    return options
  }

  private static func spanStatus(forHTTPStatus status: Int) -> SentrySpanStatus {
    switch status {
    case 200..<400: .ok
    case 401: .unauthenticated
    case 403: .permissionDenied
    case 404: .notFound
    case 408: .deadlineExceeded
    case 409: .aborted
    case 426: .failedPrecondition
    case 429: .resourceExhausted
    case 400..<500: .invalidArgument
    case 503: .unavailable
    default: .internalError
    }
  }
}

// Sends warnings and above to Sentry logs, with the category and fields as attributes.
struct SentryLogSink: LogSink {
  let reporter: any SentryReporter

  func record(_ entry: LogEntry) {
    let level: SentryLog.Level
    switch entry.level {
    case .debug, .info, .notice: return
    case .warning: level = .warn
    case .error: level = .error
    case .fault: level = .fatal
    }
    var attributes: [String: Any] = ["category": entry.category.name]
    for field in entry.fields {
      switch field.value {
      case .int(let value): attributes[field.name] = value
      case .double(let value): attributes[field.name] = value
      case .bool(let value): attributes[field.name] = value
      case .string(let value): attributes[field.name] = value
      }
    }
    reporter.log(level, entry.message, attributes: attributes)
  }
}

// Sends feedback as Sentry user feedback, with the screenshots and log tails as attachments. It
// names no one: the feedback has no name or email, and its user is the opaque Screenr user ID
// that Telemetry set. Sentry skips beforeSend for feedback, so this relies on the scope's user
// holding only that ID.
struct SentryFeedbackSender: FeedbackSender {
  let reporter: any SentryReporter

  func send(_ feedback: Feedback) {
    var attachments: [Attachment] = []
    for (index, jpeg) in feedback.screenshots.enumerated() {
      attachments.append(
        Attachment(data: jpeg, filename: "screenshot-\(index + 1).jpg", contentType: "image/jpeg")
      )
    }
    for log in feedback.logs {
      attachments.append(
        Attachment(data: log.data, filename: log.filename, contentType: "application/x-ndjson")
      )
    }
    reporter.capture(
      feedback: SentryFeedback(
        message: feedback.message,
        name: nil,
        email: nil,
        source: .custom,
        attachments: attachments
      )
    )
  }
}
