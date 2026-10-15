import SwiftUI

// A color scheme that Screenr Dev uses in place of the system's, so UI tests
// can audit dark mode, which a Simulator applies to its apps only after it
// restarts:
//
//   -ScreenrAppearance dark|light
//
// Release builds ignore it.
public enum LaunchAppearance {
  public static func colorScheme(
    in arguments: [String],
    variant: AppConfiguration.Variant
  ) -> ColorScheme? {
    guard variant == .dev, let index = arguments.firstIndex(of: "-ScreenrAppearance") else {
      return nil
    }
    let valueIndex = arguments.index(after: index)
    guard arguments.indices.contains(valueIndex) else { return nil }
    switch arguments[valueIndex] {
    case "dark": return .dark
    case "light": return .light
    default: return nil
    }
  }
}
