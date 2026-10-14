import Synchronization

// A destination for log lines beyond the unified log, such as the log file or Sentry.
public protocol LogSink: Sendable {
  func record(_ entry: LogEntry)
}

// Hands each line to every installed sink. The app installs its sinks at launch on the shared
// router; tests give their loggers a router of their own.
public final class LogRouter: Sendable {
  public static let shared = LogRouter()

  private let sinks: Mutex<[any LogSink]>

  public init(sinks: [any LogSink] = []) {
    self.sinks = Mutex(sinks)
  }

  public func add(_ sink: any LogSink) {
    sinks.withLock { $0.append(sink) }
  }

  func route(_ entry: LogEntry) {
    for sink in sinks.withLock({ $0 }) {
      sink.record(entry)
    }
  }
}
