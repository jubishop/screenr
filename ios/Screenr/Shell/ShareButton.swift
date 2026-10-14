import ScreenrKit
import SwiftUI

// Shares a destination's screenr.club link, such as a title, a feed entry's
// permalink, or a profile. The link opens the app where it is installed and
// the web elsewhere.
struct ShareButton: View {
  let destination: Destination
  // What the link names, such as the title's name, for the share sheet.
  let subject: String

  var body: some View {
    ShareLink(
      item: destination.shareURL,
      subject: Text(subject),
      preview: SharePreview(subject)
    ) {
      Label("Share", systemImage: "square.and.arrow.up")
    }
  }
}
