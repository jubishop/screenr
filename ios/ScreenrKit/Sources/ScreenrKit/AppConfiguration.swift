import Foundation

// The variant's build settings, which the app's Info.plist carries from its .xcconfig files.
public struct AppConfiguration: Equatable, Sendable {
  public enum Variant: String, Equatable, Sendable {
    case dev
    case release
  }

  public enum Failure: Error, Equatable {
    case missingValue(key: String)
    case invalidValue(key: String)
  }

  public let variant: Variant
  public let serverURL: URL
  public let appGroup: String
  // The marketing version, such as `1.0`, and the build number.
  public let version: String
  public let build: String

  // The `Screenr-Client` header, which the server checks against its minimum build.
  public var clientHeader: String { "ios/\(version)/\(build)" }

  public init(infoDictionary: [String: Any]) throws(Failure) {
    let variant = try Self.value(for: "ScreenrVariant", in: infoDictionary) {
      Variant(rawValue: $0)
    }
    self.variant = variant
    serverURL = try Self.value(for: "ScreenrServerURL", in: infoDictionary) { text in
      guard let url = URL(string: text), url.host() != nil else { return nil }
      switch (variant, url.scheme) {
      case (_, "https"), (.dev, "http"): return url
      default: return nil
      }
    }
    appGroup = try Self.value(for: "ScreenrAppGroup", in: infoDictionary) { text in
      text.isEmpty ? nil : text
    }
    version = try Self.value(for: "CFBundleShortVersionString", in: infoDictionary) { text in
      Self.matches(text, allowed: Self.digits + Self.letters + ".-_") ? text : nil
    }
    // The server reads a build of at most 15 digits.
    build = try Self.value(for: "CFBundleVersion", in: infoDictionary) { text in
      text.count <= 15 && Self.matches(text, allowed: Self.digits) ? text : nil
    }
  }

  private static let digits = "0123456789"
  private static let letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

  private static func matches(_ text: String, allowed: String) -> Bool {
    !text.isEmpty && text.allSatisfy { allowed.contains($0) }
  }

  private static func value<Value>(
    for key: String,
    in infoDictionary: [String: Any],
    parse: (String) -> Value?
  ) throws(Failure) -> Value {
    guard let text = infoDictionary[key] as? String else { throw .missingValue(key: key) }
    guard let value = parse(text) else { throw .invalidValue(key: key) }
    return value
  }
}
