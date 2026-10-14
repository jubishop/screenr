import ScreenrKit
import SwiftUI

// The bell's sheet. Closing it keeps the screen beneath as it was.
struct NotificationsSheet: View {
  var body: some View {
    NavigationStack {
      NotificationsView()
        .navigationTitle("Notifications")
        .toolbarTitleDisplayMode(.inline)
        .toolbar { CloseButton() }
    }
  }
}

// Settings, from the You tab's gear: the account screen at `/account`, which
// its destination titles Settings.
struct SettingsSheet: View {
  var body: some View {
    NavigationStack {
      DestinationView(.account)
        .toolbarTitleDisplayMode(.inline)
        .toolbar { CloseButton() }
        .navigationDestination(for: Destination.self) { destination in
          DestinationView(destination)
        }
    }
  }
}

// The system's Close button, which dismisses a sheet.
struct CloseButton: ToolbarContent {
  @Environment(\.dismiss) private var dismiss

  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button(role: .close) { dismiss() }
    }
  }
}
