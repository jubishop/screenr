import ScreenrKit
import SwiftUI

extension View {
  // The toolbar at the root of a tab: the bell with the unread count on every
  // tab, the wordmark on Circle, and the Settings gear on You.
  func rootToolbar(for tab: AppTab) -> some View {
    modifier(RootToolbar(tab: tab))
  }
}

private struct RootToolbar: ViewModifier {
  let tab: AppTab
  @Environment(ShellModel.self) private var shell

  func body(content: Content) -> some View {
    content
      .toolbarTitleDisplayMode(tab == .circle ? .inline : .automatic)
      .toolbar {
        if tab == .circle {
          // Bars keep their size, so the large content viewer shows the
          // wordmark at large text sizes.
          ToolbarItem(placement: .principal) {
            Wordmark(font: .system(.title2, weight: .heavy))
              .accessibilityShowsLargeContentViewer()
          }
        }
        if tab == .you {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              shell.router.sheet = .settings
            } label: {
              Label("Settings", systemImage: "gearshape")
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          BellButton(unread: shell.unreadNotifications) {
            shell.router.sheet = .notifications
          }
        }
      }
  }
}

// Opens Notifications, with a badge counting the unread ones, which VoiceOver
// reads as the button's value.
struct BellButton: View {
  let unread: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("Notifications", systemImage: "bell")
    }
    .badge(unread)
    .accessibilityIdentifier("bell")
  }
}
