import Foundation

// Screenr Dev's fixture launch arguments, kept in its app group so that its
// share extension, which the system starts without arguments, answers from
// the same fixtures as the app. A launch without fixtures forgets them, and
// Release builds neither keep nor read them.
public struct FixtureHandoff {
  static let key = "ScreenrFixtureArguments"

  private let defaults: UserDefaults
  private let variant: AppConfiguration.Variant

  // Nil when the app group's defaults are unavailable.
  public init?(configuration: AppConfiguration) {
    guard let defaults = UserDefaults(suiteName: configuration.appGroup) else { return nil }
    self.init(defaults: defaults, variant: configuration.variant)
  }

  init(defaults: UserDefaults, variant: AppConfiguration.Variant) {
    self.defaults = defaults
    self.variant = variant
  }

  // The app's launch arguments: keeps their fixture arguments, or forgets
  // the kept ones when there are none.
  public func keep(_ arguments: [String]) {
    guard variant == .dev else { return }
    var fixtures: [String] = []
    var remaining = arguments.dropFirst()[...]
    while let argument = remaining.popFirst() {
      guard argument.hasPrefix("-ScreenrFixture"), let value = remaining.popFirst() else {
        continue
      }
      fixtures += [argument, value]
    }
    if fixtures.isEmpty {
      defaults.removeObject(forKey: Self.key)
    } else {
      defaults.set(fixtures, forKey: Self.key)
    }
  }

  // An extension's launch arguments, with the app's kept fixture arguments.
  public func arguments(_ own: [String]) -> [String] {
    guard variant == .dev, let kept = defaults.stringArray(forKey: Self.key) else { return own }
    return own + kept
  }
}
