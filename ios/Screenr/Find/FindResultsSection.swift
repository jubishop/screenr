import ScreenrKit
import SwiftUI

// A search's results, after My services, each opening its title.
struct FindResultsSection: View {
  let find: FindModel
  let titles: [ViewingTitle]

  var body: some View {
    Section {
      ListHeader("Search results")
      ForEach(find.visibleResults(titles)) { result in
        NavigationLink(value: Destination.title(id: result.id)) {
          TitleRow(
            title: result.title,
            viewing: result.viewing,
            release: result.release,
            score: result.tmdbScore,
            matchingServiceIds: result.matchingServiceIds
          )
        }
      }
      if let message = find.resultsMessage(titles) {
        Text(message)
      }
    }
  }
}
