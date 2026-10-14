import Foundation

// Any JSON value. Request bodies are built from it, and the fixture API reads
// and compares recorded requests and responses with it.
public enum JSONValue: Codable, Hashable, Sendable, ExpressibleByStringLiteral,
  ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral,
  ExpressibleByDictionaryLiteral
{
  case null
  case bool(Bool)
  case integer(Int)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .integer(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }

  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements) { first, _ in first })
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = Self.decode(Bool.self, from: container) {
      self = .bool(value)
    } else if let value = Self.decode(Int.self, from: container) {
      self = .integer(value)
    } else if let value = Self.decode(Double.self, from: container) {
      self = .number(value)
    } else if let value = Self.decode(String.self, from: container) {
      self = .string(value)
    } else if let value = Self.decode([JSONValue].self, from: container) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .integer(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }

  // An object of the members that have values.
  static func members(_ members: [String: JSONValue?]) -> JSONValue {
    .object(members.compactMapValues { $0 })
  }

  // A value for an optional field: the value, or nil to leave the field out.
  static func optional(_ value: String?) -> JSONValue? {
    guard let value else { return nil }
    return .string(value)
  }

  static func optional(_ value: Int?) -> JSONValue? {
    guard let value else { return nil }
    return .integer(value)
  }

  static func optional(_ value: Bool?) -> JSONValue? {
    guard let value else { return nil }
    return .bool(value)
  }

  // A value for a nullable field: the value, or JSON null.
  static func nullable(_ value: String?) -> JSONValue {
    guard let value else { return .null }
    return .string(value)
  }

  // A type mismatch means the value is another kind of JSON, so the caller
  // tries the next kind.
  private static func decode<Value: Decodable>(
    _ type: Value.Type,
    from container: any SingleValueDecodingContainer
  ) -> Value? {
    do {
      return try container.decode(type)
    } catch {
      return nil
    }
  }
}
