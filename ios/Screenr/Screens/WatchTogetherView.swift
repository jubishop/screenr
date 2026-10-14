import ScreenrKit
import SwiftUI

// Watch together, `/watch-together?with=<username>`, in the Friends tab.
struct WatchTogetherView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .watchTogether(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: ["\(page.titles.count) titles to watch together"]
        )
      }
    }
  }
}
