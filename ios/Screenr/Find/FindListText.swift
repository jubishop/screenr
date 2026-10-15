import SwiftUI

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
