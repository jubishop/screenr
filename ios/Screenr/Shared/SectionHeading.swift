import SwiftUI

// A list section's heading. The system's gray heading color falls short of
// the contrast that large text needs, so headings keep the primary color.
struct SectionHeading: View {
  let title: String

  init(_ title: String) {
    self.title = title
  }

  var body: some View {
    Text(title)
      .foregroundStyle(Color.primary)
  }
}
