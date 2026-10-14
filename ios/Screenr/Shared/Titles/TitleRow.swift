import ScreenrKit
import SwiftUI

// One title in a list, such as search results or Friends recommend: its
// poster, name, kind and year, and where it streams. As on the web at phone
// widths, the overview waits for the title page. Put it in a
// `NavigationLink(value: Destination.title(id:))` to open the title.
struct TitleRow<Extra: View>: View {
  let title: Title
  let viewing: TitleViewing
  let serviceIds: [String]
  // Lines after the title's own, such as who recommends it.
  @ViewBuilder var extra: () -> Extra

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PosterImage(path: title.posterPath, name: title.name, width: 56)
      VStack(alignment: .leading, spacing: 4) {
        Text(title.name)
          .font(.headline)
        Text(title.kindAndYear)
          .font(.subheadline)
          .foregroundStyle(.muted)
        ViewingLinesView(viewing: viewing, serviceIds: serviceIds)
        extra()
      }
    }
    .padding(.vertical, 4)
  }
}

extension TitleRow where Extra == EmptyView {
  init(title: Title, viewing: TitleViewing, serviceIds: [String]) {
    self.init(title: title, viewing: viewing, serviceIds: serviceIds) { EmptyView() }
  }
}
