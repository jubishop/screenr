import SwiftUI

// The "screenr" wordmark and its dot, on screens before sign-in and, smaller,
// in the Circle tab's navigation bar.
struct Wordmark: View {
  var font: Font = .system(.largeTitle, weight: .heavy)

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(verbatim: "screenr")
        .font(font)
        .foregroundStyle(.tint)
        .accessibilityAddTraits(.isHeader)
      Image(systemName: "circle.fill")
        .font(.caption2)
        .foregroundStyle(Color.brandDot)
        .accessibilityHidden(true)
    }
  }
}
