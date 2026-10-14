import ScreenrKit
import SwiftUI

// A profile, `/people/<username>`. The viewer's own profile is the root of
// the You tab.
struct ProfileView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .profile(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: [
            page.profile.person.displayName, "@" + page.profile.person.username,
            "\(page.topTen.count) in their top 10",
          ]
        )
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            ShareButton(
              destination: .profile(username: page.profile.person.username),
              subject: page.profile.person.displayName
            )
          }
        }
      }
    }
  }
}
