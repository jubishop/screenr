import ScreenrKit
import SwiftUI

// One title in a list, such as search results, Friends recommend, or Watch
// together: its poster, name, kind and year, and where it streams. As on the
// web at phone widths, the overview waits for the title page. At
// accessibility sizes the text moves beneath the poster, which would
// otherwise leave it a few letters per line. Put it in a
// `NavigationLink(value: Destination.title(id:))` to open the title.
struct TitleRow<Extra: View>: View {
  let title: Title
  let viewing: TitleViewing
  let serviceIds: [String]
  // Whose saved services `serviceIds` are.
  var savedBy = SavedServicesOwner.viewer
  // Lines after the title's own, such as who recommends it.
  @ViewBuilder var extra: () -> Extra
  @Environment(\.dynamicTypeSize) private var size

  var body: some View {
    let layout =
      size.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
    layout {
      PosterImage(path: title.posterPath, name: title.name, width: 56)
      VStack(alignment: .leading, spacing: 4) {
        Text(title.name)
          .font(.headline)
        Text(title.kindAndYear)
          .font(.subheadline)
          .foregroundStyle(.muted)
        ViewingLinesView(viewing: viewing, serviceIds: serviceIds, savedBy: savedBy)
        extra()
      }
    }
    .padding(.vertical, 4)
  }
}

extension TitleRow where Extra == EmptyView {
  init(
    title: Title,
    viewing: TitleViewing,
    serviceIds: [String],
    savedBy: SavedServicesOwner = .viewer
  ) {
    self.init(title: title, viewing: viewing, serviceIds: serviceIds, savedBy: savedBy) {
      EmptyView()
    }
  }
}
