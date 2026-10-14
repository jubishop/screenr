import ScreenrKit
import SwiftUI

// A search's results, after My services, each opening its title.
struct FindResultsSection: View {
  let find: FindModel
  let titles: [ViewingTitle]
  let serviceIds: [String]?

  var body: some View {
    Section {
      ListHeader("Search results")
      ForEach(find.visibleResults(titles, serviceIds: serviceIds)) { result in
        NavigationLink(value: Destination.title(id: result.id)) {
          TitleRow(title: result.title, viewing: result.viewing, serviceIds: serviceIds ?? [])
        }
      }
      if let message = find.resultsMessage(titles, serviceIds: serviceIds) {
        Text(message)
      }
    }
  }
}
