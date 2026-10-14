import SwiftUI

// A list's heading, such as "From your circle", as the section's first row:
// section headers are too faint and do not grow with Dynamic Type.
struct ListHeader: View {
  let title: String

  init(_ title: String) {
    self.title = title
  }

  var body: some View {
    Text(title)
      .font(.headline)
      .accessibilityAddTraits(.isHeader)
  }
}

// A symbol before a few words, as one line of text that wraps and grows with
// Dynamic Type, unlike a label's fixed symbol column in a list row. The
// symbol is decorative.
struct SymbolText: View {
  let title: String
  let systemImage: String

  init(_ title: String, systemImage: String) {
    self.title = title
    self.systemImage = systemImage
  }

  var body: some View {
    Text("\(Image(systemName: systemImage)) \(title)")
      .accessibilityLabel(title)
  }
}

// Why a list is empty, such as before friends recommend anything.
struct EmptyListMessage: View {
  let title: String
  let message: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.headline)
      Text(message)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}
