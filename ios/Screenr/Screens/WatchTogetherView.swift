import ScreenrKit
import SwiftUI

// Watch together, `/watch-together?with=<username>`, in the Friends tab:
// every title the viewer and one friend both want to watch, newest shared
// first, with those either can watch now ahead of the rest. Each opens its
// title page, where they change their choices.
struct WatchTogetherView: View {
  let model: ScreenModel
  let destination: Destination
  // Kept outside the screen's content, so it outlives a failed read.
  @State private var filter = WatchTogetherFilter.all

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .watchTogether(let page) = screen.content {
        WatchTogetherList(page: page, filter: $filter)
      }
    }
  }
}
