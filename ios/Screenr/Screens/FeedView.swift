import ScreenrKit
import SwiftUI

// The friends feed, `/`, at the root of Circle. Its destination can name an
// entry and reply to show, which the screen's `target` confirms.
struct FeedView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .feed(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: ["\(page.conversations.count) entries"]
        )
      }
    }
  }
}
