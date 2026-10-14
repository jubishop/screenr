import ScreenrKit
import SwiftUI

// Invite friends, which opens the member's invitation links in Settings.
struct InvitationsSection: View {
  let settings: SettingsContext

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      NavigationLink(value: Destination.invites) {
        Label("Invite friends", systemImage: "person.badge.plus")
      }
    } header: {
      SectionHeading("Invitations")
    } footer: {
      Text(
        "Share an invitation link to bring friends to Screenr. When someone signs up through your link, you become friends."
      )
    }
  }
}
