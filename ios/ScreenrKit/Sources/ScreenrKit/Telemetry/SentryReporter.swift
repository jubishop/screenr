import Sentry

// The Sentry operations Telemetry uses. Release builds send them to the global SDK; tests send
// them to a client of their own, so they can read what Sentry would send.
protocol SentryReporter: Sendable {
  func setUser(_ user: sending User?)
  func add(_ breadcrumb: sending Breadcrumb)
  func capture(error: any Error, tags: [String: String])
  func capture(feedback: sending SentryFeedback)
  func log(_ level: SentryLog.Level, _ body: String, attributes: sending [String: Any])
  // Starts a transaction and hands it to configure, which finishes it.
  func recordTransaction(_ context: sending TransactionContext, configure: (any Span) -> Void)
}

// The global SDK, which only Release builds start.
struct SentrySDKReporter: SentryReporter {
  static func start(_ options: sending Options) -> any SentryReporter {
    SentrySDK.start(options: options)
    return SentrySDKReporter()
  }

  func setUser(_ user: sending User?) {
    SentrySDK.setUser(user)
  }

  func add(_ breadcrumb: sending Breadcrumb) {
    SentrySDK.addBreadcrumb(breadcrumb)
  }

  func capture(error: any Error, tags: [String: String]) {
    SentrySDK.capture(error: error) { scope in
      scope.setTags(tags)
    }
  }

  func capture(feedback: sending SentryFeedback) {
    SentrySDK.capture(feedback: feedback)
  }

  func log(_ level: SentryLog.Level, _ body: String, attributes: sending [String: Any]) {
    let logger = SentrySDK.logger
    switch level {
    case .trace: logger.trace(body, attributes: attributes)
    case .debug: logger.debug(body, attributes: attributes)
    case .info: logger.info(body, attributes: attributes)
    case .warn: logger.warn(body, attributes: attributes)
    case .error: logger.error(body, attributes: attributes)
    case .fatal: logger.fatal(body, attributes: attributes)
    @unknown default: logger.error(body, attributes: attributes)
    }
  }

  func recordTransaction(_ context: sending TransactionContext, configure: (any Span) -> Void) {
    configure(SentrySDK.startTransaction(transactionContext: context))
  }
}
