import ScreenrKit
import SwiftUI

// Find a title, `/search`, at the root of the search-role tab. A link's search
// and tab arrive as the router's `findSearch`.
struct FindView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(ShellModel.self) private var shell
  @State private var text = ""

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .search(let page) = screen.content {
        PlaceholderScreen(
          destination: shell.router.findSearch,
          details: [
            "\(page.suggestions.count) suggestions",
            "\(page.recommendations.count) friends recommend",
          ]
        )
      }
    }
    .searchable(text: $text, prompt: "Movies and TV shows")
    .onChange(of: shell.router.findSearch, initial: true) { _, search in
      if case .search(let query?, _) = search { text = query }
    }
  }
}
