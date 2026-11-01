// Text that Screenr Dev shows over every screen, so a UI test can check that
// its accessibility audits still fail on a real problem in the app's content:
//
//   -ScreenrAuditProbe faintClippedText
//
// Release builds ignore it.
public enum AuditProbe: String, Hashable, Sendable {
  // One line of faint text, cut off at its width.
  case faintClippedText

  public static func launch(in arguments: [String], variant: AppConfiguration.Variant)
    -> AuditProbe?
  {
    guard variant == .dev, let index = arguments.firstIndex(of: "-ScreenrAuditProbe") else {
      return nil
    }
    let valueIndex = arguments.index(after: index)
    guard arguments.indices.contains(valueIndex) else { return nil }
    return AuditProbe(rawValue: arguments[valueIndex])
  }
}
