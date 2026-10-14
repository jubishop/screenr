import SwiftUI

// The "screenr" wordmark and its dot.
struct Wordmark: View {
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text(verbatim: "screenr")
        .font(.system(.largeTitle, weight: .heavy))
        .foregroundStyle(.tint)
        .accessibilityAddTraits(.isHeader)
      Image(systemName: "circle.fill")
        .font(.caption2)
        .foregroundStyle(Color.brandDot)
        .accessibilityHidden(true)
    }
  }
}

struct WordmarkView: View {
  var body: some View {
    Wordmark()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color(uiColor: .systemBackground))
  }
}
