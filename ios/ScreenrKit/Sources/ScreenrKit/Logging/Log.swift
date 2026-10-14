import Foundation
import os

// A logger for one category. Each line goes to the unified log and to the router's sinks: the
// log file, and Sentry for warnings and above in Release builds. A message is a string literal and
// each field holds a number, a flag, a constant, an opaque ID, a route pattern, or an error's type
// and code, so no line can carry what members write, search for, or are called.
public struct Log: Sendable {
  public static let app = Log(.app)
  public static let api = Log(.api)
  public static let session = Log(.session)
  public static let push = Log(.push)
  public static let telemetry = Log(.telemetry)

  static let subsystem = "com.artisanalsoftware.Screenr"

  public let category: LogCategory
  private let router: LogRouter
  private let logger: os.Logger

  public init(_ category: LogCategory, router: LogRouter = .shared) {
    self.category = category
    self.router = router
    logger = os.Logger(subsystem: Self.subsystem, category: category.name)
  }

  public func debug(_ message: StaticString, _ fields: LogField...) {
    write(.debug, message, fields)
  }

  public func info(_ message: StaticString, _ fields: LogField...) {
    write(.info, message, fields)
  }

  public func notice(_ message: StaticString, _ fields: LogField...) {
    write(.notice, message, fields)
  }

  public func warning(_ message: StaticString, _ fields: LogField...) {
    write(.warning, message, fields)
  }

  public func error(_ message: StaticString, _ fields: LogField...) {
    write(.error, message, fields)
  }

  public func fault(_ message: StaticString, _ fields: LogField...) {
    write(.fault, message, fields)
  }

  func write(_ level: LogLevel, _ message: StaticString, _ fields: [LogField]) {
    let entry = LogEntry(
      date: .now,
      level: level,
      category: category,
      message: message.description,
      fields: fields
    )
    let text = entry.text
    logger.log(level: level.osLogType, "\(text, privacy: .public)")
    router.route(entry)
  }
}

public enum LogLevel: Int, Comparable, Sendable, CaseIterable {
  case debug
  case info
  case notice
  case warning
  case error
  case fault

  public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool { lhs.rawValue < rhs.rawValue }

  public var name: String {
    switch self {
    case .debug: "debug"
    case .info: "info"
    case .notice: "notice"
    case .warning: "warning"
    case .error: "error"
    case .fault: "fault"
    }
  }

  var osLogType: OSLogType {
    switch self {
    case .debug: .debug
    case .info: .info
    case .notice: .default
    case .warning, .error: .error
    case .fault: .fault
    }
  }
}

// A log category, the unified log's category for its lines. Features may add their own.
public struct LogCategory: Sendable, Hashable {
  public static let app = LogCategory("app")
  public static let api = LogCategory("api")
  public static let session = LogCategory("session")
  public static let push = LogCategory("push")
  public static let telemetry = LogCategory("telemetry")

  public let name: String

  public init(_ name: StaticString) {
    self.name = name.description
  }
}

// One logged line, as the sinks receive it.
public struct LogEntry: Sendable, Equatable {
  public let date: Date
  public let level: LogLevel
  public let category: LogCategory
  public let message: String
  public let fields: [LogField]

  // The message followed by each field as name=value.
  public var text: String {
    ([message] + fields.map { "\($0.name)=\($0.value)" }).joined(separator: " ")
  }
}
