import ScreenrKit
import SwiftUI

// A title's TMDB poster in its 2:3 frame, or the title's initial while it
// loads or without one. It is decorative: the title's name sits beside it or
// labels the link around it.
struct PosterImage: View {
  let path: String?
  let name: String
  var width: CGFloat = 72
  @Environment(\.imageSource) private var images
  @ScaledMetric private var scale: CGFloat = 1

  var body: some View {
    AsyncImage(request: images.poster(path)) { phase in
      // AsyncImage hosts its content apart, so it is hidden here too.
      if case .success(let image) = phase {
        image.resizable().scaledToFill().accessibilityHidden(true)
      } else {
        Text(String(name.prefix(1)))
          .font(.title2.weight(.semibold))
          .foregroundStyle(.primary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(uiColor: .secondarySystemFill))
          .accessibilityHidden(true)
      }
    }
    .frame(width: width * scale, height: width * scale * 1.5)
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .accessibilityHidden(true)
  }
}
