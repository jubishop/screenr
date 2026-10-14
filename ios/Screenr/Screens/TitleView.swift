import ScreenrKit
import SwiftUI

// A title page, `/titles/<kind>/<TMDB ID>`. Its destination can name an entry
// and reply to show, which the screen's `target` confirms.
struct TitleView: View {
  let model: ScreenModel
  let destination: Destination

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .title(let page) = screen.content {
        PlaceholderScreen(
          destination: destination,
          details: [page.title.name, "\(page.conversations.count) entries"]
        )
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            ShareButton(destination: .title(id: page.title.id), subject: page.title.name)
          }
        }
      }
    }
  }
}
