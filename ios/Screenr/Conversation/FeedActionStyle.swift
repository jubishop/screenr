import SwiftUI

// The feed's small actions, such as Reply, reaction counts, and View 2 replies:
// compact to look at, with a hit area at least 44 points tall. A filled action
// sits in a capsule, tinted when it shows the reader's choice; a text action
// has none. Destructive actions are red.
struct FeedActionStyle: ButtonStyle {
  enum Kind {
    case filled
    case chosen
    case text
  }

  var kind = Kind.filled

  func makeBody(configuration: Configuration) -> some View {
    FeedActionLabel(kind: kind, role: configuration.role, isPressed: configuration.isPressed) {
      configuration.label
    }
  }
}

extension ButtonStyle where Self == FeedActionStyle {
  static var feedAction: FeedActionStyle { FeedActionStyle() }
  static var feedText: FeedActionStyle { FeedActionStyle(kind: .text) }

  static func feedAction(chosen: Bool) -> FeedActionStyle {
    FeedActionStyle(kind: chosen ? .chosen : .filled)
  }
}

// The look of a feed action, also used for labels that are not buttons'
// own, such as React's menu.
struct FeedActionLabel<Label: View>: View {
  let kind: FeedActionStyle.Kind
  var role: ButtonRole?
  var isPressed = false
  @ViewBuilder let label: () -> Label
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    label()
      .font(.subheadline)
      .foregroundStyle(foreground)
      .padding(.horizontal, kind == .text ? 0 : 12)
      .padding(.vertical, 6)
      .background {
        switch kind {
        case .filled: Capsule().fill(Color(uiColor: .secondarySystemFill))
        case .chosen: Capsule().fill(Color.accentColor.opacity(0.2))
        case .text: EmptyView()
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
      .opacity(isPressed ? 0.6 : 1)
  }

  // An unavailable action reads as muted text, which keeps its contrast.
  private var foreground: AnyShapeStyle {
    if !isEnabled { return AnyShapeStyle(.muted) }
    return role == .destructive ? AnyShapeStyle(.danger) : AnyShapeStyle(.tint)
  }
}
