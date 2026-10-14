import Foundation

// A link that Screenr Dev opens at launch, as if the system had delivered it,
// so UI tests can start at any destination:
//
//   -ScreenrOpenURL screenr-dev://titles/tv/201?item=<entry>
//
// Release builds ignore it.
public enum LaunchLink {
  public static func url(in arguments: [String], variant: AppConfiguration.Variant) -> URL? {
    guard variant == .dev, let index = arguments.firstIndex(of: "-ScreenrOpenURL") else {
      return nil
    }
    let valueIndex = arguments.index(after: index)
    guard arguments.indices.contains(valueIndex) else { return nil }
    return URL(string: arguments[valueIndex])
  }
}
