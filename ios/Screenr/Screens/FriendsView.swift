import ScreenrKit
import SwiftUI

// Friends, `/people`, at the root of the Friends tab.
struct FriendsView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .people(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: [
            "\(page.connections.count) friends and requests",
            "\(page.suggestions.count) people you may know",
          ]
        )
      }
    }
  }
}
