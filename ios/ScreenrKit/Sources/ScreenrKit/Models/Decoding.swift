import Foundation

// A string enum from the server. A value this build does not know decodes as
// `unknown` instead of failing the whole response, so the server can add cases.
public protocol ServerEnum: RawRepresentable, Codable, Hashable, Sendable
where RawValue == String {
  static var unknown: Self { get }
}

extension ServerEnum {
  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    self = Self(rawValue: value) ?? .unknown
  }
}

// The JSON coders for the Screenr API. Keys are snake_case or camelCase on the
// server; models name properties after the camelCase form, such as `userId`.
public enum ScreenrJSON {
  public static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let text = try container.decode(String.self)
      guard let date = ServerTimestamp.date(from: text) else {
        throw DecodingError.dataCorruptedError(
          in: container,
          debugDescription: "Expected an ISO 8601 timestamp, not \(text)"
        )
      }
      return date
    }
    return decoder
  }

  public static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

// Parses the server's timestamps. JavaScript dates arrive as
// `2026-10-13T12:00:00.000Z`, and PostgreSQL JSON timestamps as
// `2026-10-13T12:00:00.123456+00:00`, with trailing zeros of the fraction, or
// the whole fraction, dropped. Any fraction length and offset are accepted.
public enum ServerTimestamp {
  public static func date(from text: String) -> Date? {
    var scanner = Digits(Array(text.utf8))
    guard let year = scanner.number(length: 4), scanner.skip("-"),
      let month = scanner.number(length: 2), scanner.skip("-"),
      let day = scanner.number(length: 2), scanner.skip("T") || scanner.skip(" "),
      let hour = scanner.number(length: 2), scanner.skip(":"),
      let minute = scanner.number(length: 2), scanner.skip(":"),
      let second = scanner.number(length: 2)
    else { return nil }
    var fraction = 0.0
    if scanner.skip(".") {
      let digits = scanner.digits()
      guard !digits.isEmpty else { return nil }
      var scale = 0.1
      for digit in digits {
        fraction += Double(digit) * scale
        scale /= 10
      }
    }
    guard let offset = scanner.offset(), scanner.isAtEnd,
      (1...12).contains(month), (1...31).contains(day),
      hour < 24, minute < 60, second < 61
    else { return nil }
    let days = daysSinceEpoch(year: year, month: month, day: day)
    let seconds = ((days * 24 + hour) * 60 + minute) * 60 + second - offset
    return Date(timeIntervalSince1970: Double(seconds) + fraction)
  }

  // Days from 1970-01-01 to a date in the proleptic Gregorian calendar.
  private static func daysSinceEpoch(year: Int, month: Int, day: Int) -> Int {
    let shifted = month <= 2 ? year - 1 : year
    let era = (shifted >= 0 ? shifted : shifted - 399) / 400
    let yearOfEra = shifted - era * 400
    let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
  }

  private struct Digits {
    private let bytes: [UInt8]
    private var index = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    var isAtEnd: Bool { index == bytes.count }

    mutating func skip(_ character: Character) -> Bool {
      guard index < bytes.count, let ascii = character.asciiValue, bytes[index] == ascii else {
        return false
      }
      index += 1
      return true
    }

    mutating func number(length: Int) -> Int? {
      guard index + length <= bytes.count else { return nil }
      var value = 0
      for byte in bytes[index..<index + length] {
        guard let digit = Self.digit(byte) else { return nil }
        value = value * 10 + digit
      }
      index += length
      return value
    }

    mutating func digits() -> [Int] {
      var digits: [Int] = []
      while index < bytes.count, let digit = Self.digit(bytes[index]) {
        digits.append(digit)
        index += 1
      }
      return digits
    }

    // The offset from UTC in seconds: `Z`, `+HH:MM`, `+HHMM`, or `+HH`.
    mutating func offset() -> Int? {
      if skip("Z") || skip("z") { return 0 }
      let sign: Int
      if skip("+") {
        sign = 1
      } else if skip("-") {
        sign = -1
      } else {
        return nil
      }
      guard let hours = number(length: 2) else { return nil }
      var minutes = 0
      if !isAtEnd {
        _ = skip(":")
        guard let value = number(length: 2) else { return nil }
        minutes = value
      }
      return sign * (hours * 3600 + minutes * 60)
    }

    private static func digit(_ byte: UInt8) -> Int? {
      (48...57).contains(byte) ? Int(byte - 48) : nil
    }
  }
}
