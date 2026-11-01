import ScreenrKit
import SwiftUI

// A profile's Want to watch page, `/people/<username>/want-to-watch`. At
// home lists the owner's Want to watch titles the viewer can watch now,
// newest first, then those whose availability is unknown. In theaters,
// `?mode=theaters`, lists the owner's movies in US theaters now. Each opens
// its title page, where the viewer changes their own choices. The viewer's
// own page and accepted friends' pages load; the server answers others with
// "Want to watch not found."
struct WantToWatchView: View {
  let model: ScreenModel
  let destination: Destination
  // Kept outside the screen's content, so it outlives a failed read.
  @State private var filter = TitleKindFilter.all

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .wantToWatch(let page) = screen.content {
        WantToWatchList(
          page: page,
          viewer: screen.user.userId,
          destination: destination,
          filter: $filter
        )
      } else if case .wantToWatchInTheaters(let page) = screen.content {
        InTheatersList(
          people: [page.owner],
          introduction: page.introduction(viewer: screen.user.userId),
          sections: page.sections(viewer: screen.user.userId),
          destination: destination,
          open: WantToWatchInTheatersScreen.destination(of:)
        )
      }
    }
  }
}
