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

  public let state: State
  private let reporter: (any SentryReporter)?
  private let api: Log

  public convenience init(configuration: AppConfiguration, router: LogRouter = .shared) {
    self.init(
      variant: configuration.variant,
      router: router,
      sessionRoll: Double.random(in: 0..<1),
      start: SentrySDKReporter.start
    )
  }

  // sessionRoll, from 0 up to 1, decides whether this session is traced.
  init(
    variant: AppConfiguration.Variant,
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
      let reporter = start(Self.options(traced: sessionRoll < Self.tracedShare))
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

  public func requestFinished(_ request: APIRequestRecord) {
    var fields: [LogField] = [
      LogField(name: "method", value: .string(request.method)),
      .route(request.route),
      .identifier("request_id", request.requestID),
    ]
    let level: LogLevel
    let breadcrumbLevel: SentryLevel
    let spanStatus: SentrySpanStatus
    switch request.outcome {
    case .response(let status):
      fields.append(.int("status", status))
      level = status >= 500 ? .warning : .info
      breadcrumbLevel = status >= 500 ? .error : status >= 400 ? .warning : .info
      spanStatus = Self.spanStatus(forHTTPStatus: status)
    case .failed(let code):
      fields.append(.int("error_code", code))
      let cancelled = code == URLError.cancelled.rawValue
      level = cancelled ? .info : .warning
      breadcrumbLevel = cancelled ? .info : .error
      spanStatus = cancelled ? .cancelled : .unavailable
    }
    fields.append(.duration("duration_ms", request.duration))
    api.write(level, "Request finished", fields)

    guard let reporter else { return }
    let breadcrumb = Breadcrumb(level: breadcrumbLevel, category: "http")
    breadcrumb.type = "http"
    breadcrumb.setData(value: request.method, key: "method")
    breadcrumb.setData(value: request.route.value, key: "url")
    breadcrumb.setData(value: request.requestID, key: "request_id")
    breadcrumb.setData(value: request.duration.milliseconds, key: "duration_ms")
    if case .response(let status) = request.outcome {
      breadcrumb.setData(value: status, key: "status_code")
    }
    reporter.add(breadcrumb)

    let end = Date.now
    let start = end.addingTimeInterval(-request.duration.milliseconds / 1_000)
    let context = TransactionContext(
      name: "\(request.method) \(request.route.path)",
      operation: "http.client"
    )
    reporter.recordTransaction(context) { transaction in
      transaction.startTimestamp = start
      transaction.setTag(value: request.requestID, key: "request_id")
      if case .response(let status) = request.outcome {
        transaction.setData(value: status, key: "http.response.status_code")
      }
      transaction.finish(status: spanStatus)
    }
  }

  static func options(traced: Bool) -> Options {
    let options = Options()
    options.dsn = releaseDSN
    options.environment = "production"
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
