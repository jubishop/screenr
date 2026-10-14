import ScreenrKit
import SwiftUI

// The bell's notifications, in a sheet over the current screen.
struct NotificationsView: View {
  @Environment(ShellModel.self) private var shell

  var body: some View {
    MessageView(
      title: "Notifications",
      systemImage: "bell",
      message: "\(shell.unreadNotifications) unread. This screen is coming soon."
    )
  }
}
