import SwiftUI

// Shown when the server no longer accepts this build, until the member
// installs a newer one.
struct RequiredUpdateView: View {
  // Where members get new builds: TestFlight now, and the App Store later.
  static let updateURL: URL = {
    guard let url = URL(string: "https://testflight.apple.com") else {
      preconditionFailure("The update URL is invalid")
    }
    return url
  }()

  @Environment(\.openURL) private var openURL

  var body: some View {
    MessageView(
      title: "Update Screenr",
      systemImage: "arrow.down.app",
      message:
        "This version of Screenr is no longer supported. Install the latest version to keep using it."
    ) {
      Button("Open TestFlight") {
        openURL(Self.updateURL)
      }
      .buttonStyle(.bordered)
      .accessibilityHint("Opens TestFlight, where you can install the latest Screenr.")
    }
    .background(Color(uiColor: .systemBackground))
  }
}
