import Foundation

// The variant's build settings, which the app's Info.plist carries from its .xcconfig files.
public struct AppConfiguration: Equatable, Sendable {
  public enum Variant: String, Equatable, Sendable, CaseIterable {
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
  // The Google OAuth client for iOS, such as `123-abc.apps.googleusercontent.com`.
  public let googleClientID: String
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
    googleClientID = try Self.value(for: "ScreenrGoogleClientID", in: infoDictionary) { text in
      let suffix = GoogleSignIn.clientIDSuffix
      guard text.hasSuffix(suffix) else { return nil }
      let client = text.dropLast(suffix.count)
      return Self.matches(String(client), allowed: Self.digits + Self.letters + "-") ? text : nil
    }
    version = try Self.value(for: "CFBundleShortVersionString", in: infoDictionary) { text in
      Self.matches(text, allowed: Self.digits + Self.letters + ".-_") ? text : nil
    }
    build = try String(Self.buildNumber(in: infoDictionary))
  }

  // Where APNs reaches the app: the environment of its `aps-environment`
  // entitlement, its bundle ID as the topic, and its build. Only the app reads
  // it; its extensions have no `aps-environment` entitlement. The Info.plist
  // repeats the entitlement's value from the same build setting, so a token
  // always names the environment that issued it: `development` for Screenr
  // Dev, which runs in the Simulator, and `production` for TestFlight and App
  // Store builds.
  public static func pushTarget(infoDictionary: [String: Any]) throws(Failure) -> PushTarget {
    let topic = try value(for: "CFBundleIdentifier", in: infoDictionary) { text in
      matches(text, allowed: digits + letters + ".-") ? text : nil
    }
    let environment = try value(for: "ScreenrAPSEnvironment", in: infoDictionary) {
      text -> PushEnvironment? in
      switch text {
      case "development": .sandbox
      case "production": .production
      default: nil
      }
    }
    return try PushTarget(
      environment: environment,
      topic: topic,
      build: buildNumber(in: infoDictionary)
    )
  }

  // The server reads a positive build of at most 15 digits.
  private static func buildNumber(in infoDictionary: [String: Any]) throws(Failure) -> Int {
    try value(for: "CFBundleVersion", in: infoDictionary) { text in
      guard text.count <= 15, matches(text, allowed: digits), let number = Int(text), number > 0
      else { return nil }
      return number
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
