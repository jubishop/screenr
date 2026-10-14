import SwiftUI

// Text colors that keep a 4.5:1 contrast at small sizes in light and dark
// mode, which the system's secondary label and red fall just short of.
extension ShapeStyle where Self == Color {
  // De-emphasized text, such as times and "Comment removed".
  static var muted: Color { Color(uiColor: .label).opacity(0.7) }

  // Text on the accent color: white on the light theme's deep green, and
  // black on the dark theme's lime.
  static var onAccent: Color {
    Color(
      uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? .black : .white }
    )
  }

  // Destructive actions and failure messages, also on a bordered button's
  // gray fill.
  static var danger: Color {
    Color(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
          ? UIColor(red: 1, green: 0.63, blue: 0.6, alpha: 1)
          : UIColor(red: 0.72, green: 0.09, blue: 0.09, alpha: 1)
      }
    )
  }
}
