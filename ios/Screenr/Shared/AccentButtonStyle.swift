import SwiftUI

// The system's prominent button, filled with the accent color, with its label
// in `.onAccent`. The system draws the label white, which falls short of 4.5:1
// contrast on the dark theme's lime. A disabled button keeps the system's gray
// fill and label.
struct AccentButtonStyle: PrimitiveButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button(role: configuration.role) {
      configuration.trigger()
    } label: {
      OnAccentLabel { configuration.label }
    }
    .buttonStyle(.borderedProminent)
  }
}

extension PrimitiveButtonStyle where Self == AccentButtonStyle {
  static var accent: AccentButtonStyle { AccentButtonStyle() }
}

private struct OnAccentLabel<Label: View>: View {
  @ViewBuilder let label: () -> Label
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    if isEnabled {
      label().foregroundStyle(.onAccent)
    } else {
      label()
    }
  }
}
