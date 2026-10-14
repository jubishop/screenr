import ScreenrKit
import SwiftUI

// First-time setup, for a signed-in member without a profile. Setup sends the
// pending invitation's token, and once it succeeds, `shell.checkAccount()`
// shows the tabs.
struct SetupView: View {
  @Environment(PendingInvitation.self) private var invitation

  var body: some View {
    VStack(spacing: 16) {
      Wordmark()
      Text("Set up your profile")
        .font(.title2.weight(.semibold))
        .accessibilityAddTraits(.isHeader)
      Text("Choosing your name and username is coming soon.")
      if invitation.token != nil {
        Text("You have an invitation to join Screenr.")
      }
      SignOutButton()
    }
    .multilineTextAlignment(.center)
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(uiColor: .systemBackground))
  }
}
