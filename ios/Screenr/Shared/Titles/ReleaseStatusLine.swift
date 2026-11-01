import ScreenrKit
import SwiftUI

// A title's US release status, such as "In theaters · Digital Nov 20", in
// title lists and atop Where to watch. Nothing shows without a label.
struct ReleaseStatusLine: View {
  let release: TitleRelease?
  var font = Font.footnote

  var body: some View {
    if let text = release?.text {
      Text(text)
        .font(font.weight(.semibold))
    }
  }
}
