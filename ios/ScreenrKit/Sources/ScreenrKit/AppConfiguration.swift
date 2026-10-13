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
