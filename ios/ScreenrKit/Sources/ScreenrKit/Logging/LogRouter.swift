import Foundation
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

  // The log file that writes `name` in `directory`: the one this router has
  // already, or a new one it adds. Each file has one writer, since two would
  // both write every line and rotate away each other's files, as a share
  // extension that iOS keeps running between shares would otherwise do.
  public func file(_ name: String, in directory: URL) -> LogFile {
    let current = LogFile.currentURL(name, in: directory)
    return sinks.withLock { sinks in
      for case let file as LogFile in sinks where file.currentURL == current { return file }
      let file = LogFile(directory: directory, name: name)
      sinks.append(file)
      return file
    }
  }

  func route(_ entry: LogEntry) {
    for sink in sinks.withLock({ $0 }) {
      sink.record(entry)
    }
  }
}
