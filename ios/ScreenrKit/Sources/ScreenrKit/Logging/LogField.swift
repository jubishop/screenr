import Foundation

// A named value on a log line. The factories accept only values that cannot hold member content:
// numbers, flags, durations, string literals, enum cases, opaque IDs, route patterns, and an
// error's type and code. There is deliberately no factory for an arbitrary string.
public struct LogField: Sendable, Equatable {
  public enum Value: Sendable, Equatable, CustomStringConvertible, Encodable {
    case int(Int)
    case double(Double)
    case bool(Bool)
    case string(String)

    public var description: String {
      switch self {
      case .int(let value): String(value)
      case .double(let value): String(value)
      case .bool(let value): String(value)
      case .string(let value): value
      }
    }

    public func encode(to encoder: any Encoder) throws {
      var container = encoder.singleValueContainer()
      switch self {
      case .int(let value): try container.encode(value)
      case .double(let value): try container.encode(value)
      case .bool(let value): try container.encode(value)
      case .string(let value): try container.encode(value)
      }
    }
  }

  public let name: String
  public let value: Value

  public static func int(_ name: StaticString, _ value: Int) -> LogField {
    LogField(name: name.description, value: .int(value))
  }

  public static func double(_ name: StaticString, _ value: Double) -> LogField {
    LogField(name: name.description, value: .double(value))
  }

  public static func bool(_ name: StaticString, _ value: Bool) -> LogField {
    LogField(name: name.description, value: .bool(value))
  }

  // A duration in milliseconds.
  public static func duration(_ name: StaticString, _ value: Duration) -> LogField {
    LogField(name: name.description, value: .double(value.milliseconds))
  }

  public static func constant(_ name: StaticString, _ value: StaticString) -> LogField {
    LogField(name: name.description, value: .string(value.description))
  }

  // An enum case, by its raw value.
  public static func label<Label: RawRepresentable & CaseIterable>(
    _ name: StaticString,
    _ value: Label
  ) -> LogField where Label.RawValue == String {
    LogField(name: name.description, value: .string(value.rawValue))
  }

  // An opaque identifier, such as a request ID or a Screenr user ID. Never pass a username,
  // email address, display name, or anything a member typed.
  public static func identifier(_ name: StaticString, _ value: String) -> LogField {
    LogField(name: name.description, value: .string(value))
  }

  public static func route(_ pattern: RoutePattern) -> LogField {
    LogField(name: "route", value: .string(pattern.value))
  }

  // The error's domain and code, which for a Swift error are its type and case number. Its
  // message and associated values can hold content, so they are left out.
  public static func error(_ error: any Error) -> LogField {
    let error = error as NSError
    return LogField(name: "error", value: .string("\(error.domain) \(error.code)"))
  }
}

extension Duration {
  var milliseconds: Double {
    let (seconds, attoseconds) = components
    return Double(seconds) * 1_000 + Double(attoseconds) / 1_000_000_000_000_000
  }
}
