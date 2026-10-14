import SwiftUI

// Why an action did not happen, beside the control that tried it. The red
// symbol is decorative; the text keeps the standard color for contrast.
struct FailureLabel: View {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .accessibilityHidden(true)
      Text(message)
    }
  }
}
