import SwiftUI

// A strip below a form, in the form's background, for a note that stays in
// view however the form scrolls, such as a message's length or what follows a
// report. In the iOS 27 Simulator, the accessibility audit failed a grouped
// list's footer text for Dynamic Type, and passed this strip.
struct FormNoteBar<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      content
    }
    .font(.footnote)
    .foregroundStyle(.muted)
    .padding(.horizontal, 32)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color(uiColor: .systemGroupedBackground))
  }
}
