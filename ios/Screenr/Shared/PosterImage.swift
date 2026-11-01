import ScreenrKit
import SwiftUI

// A title's TMDB poster in its 2:3 frame, or the title's initial while it
// loads or without one. The title's name sits beside it or labels the link
// around it. It is hidden from accessibility, so the initial never joins that
// label, which UI tests find the link by, though UI tests and audits still
// find the initial inside the link.
struct PosterImage: View {
  // What fills the frame.
  private enum Shown {
    case initial
    case poster
  }

  let path: String?
  let name: String
  var width: CGFloat = 72
  @Environment(\.imageSource) private var images
  @ScaledMetric private var scale: CGFloat = 1
  @State private var shown = Shown.initial

  var body: some View {
    AsyncImage(request: images.poster(path)) { phase in
      // AsyncImage hosts its content apart, so it is hidden here too.
      if case .success(let image) = phase {
        image.resizable().scaledToFill().accessibilityHidden(true)
          .onAppear { shown = .poster }
          .onDisappear { shown = .initial }
      }
    }
    .frame(width: width * scale, height: width * scale * 1.5)
    // The initial sits outside AsyncImage, whose hosted content can escape
    // the hiding below. It shows only while no poster does, so it never sits
    // beneath one, where an audit would measure the poster as its background.
    .background {
      if shown == .initial {
        Text(String(name.prefix(1)))
          .font(.title2.weight(.semibold))
          .foregroundStyle(.primary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(uiColor: .secondarySystemFill))
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .accessibilityHidden(true)
  }
}
