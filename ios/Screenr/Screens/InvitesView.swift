import ScreenrKit
import SwiftUI

// Invitations, `/invites`, which links open in the Friends tab.
struct InvitesView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .invites(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: ["\(page.invitations.count) open invitations"]
        )
      }
    }
  }
}
