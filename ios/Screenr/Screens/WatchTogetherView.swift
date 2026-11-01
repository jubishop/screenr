import ScreenrKit
import SwiftUI

// Watch together, `/watch-together?with=<username>`, in the Friends tab. At
// home lists every title the viewer and one friend both want to watch,
// newest shared first, with those either can watch now ahead of the rest.
// In theaters, `&mode=theaters`, lists their shared movies in US theaters
// now. Each opens its title page, where they change their choices.
struct WatchTogetherView: View {
  let model: ScreenModel
  let destination: Destination
  // Kept outside the screen's content, so it outlives a failed read.
  @State private var filter = TitleKindFilter.all

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .watchTogether(let page) = screen.content {
        WatchTogetherList(page: page, destination: destination, filter: $filter)
      } else if case .watchTogetherInTheaters(let page) = screen.content {
        InTheatersList(
          people: page.participants,
          introduction: WatchTogetherInTheatersScreen.introduction,
          sections: page.sections,
          destination: destination,
          open: WatchTogetherInTheatersScreen.destination(of:)
        )
      }
    }
  }
}
