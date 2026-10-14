import ScreenrKit
import SwiftUI

// Stands in for a feature screen that is still to come. It shows what the
// loaded screen holds, the destination's member path, and any controls the
// screen already needs.
struct PlaceholderScreen<Controls: View>: View {
  let destination: Destination
  var details: [String] = []
  @ViewBuilder var controls: () -> Controls

  var body: some View {
    List {
      Section {
        ForEach(details, id: \.self) { detail in
          Text(detail)
        }
        Text(destination.path)
          .font(.body.monospaced())
        Text("This screen is coming soon.")
      }
      Section {
        controls()
      }
    }
  }
}

extension PlaceholderScreen where Controls == EmptyView {
  init(destination: Destination, details: [String] = []) {
    self.init(destination: destination, details: details) { EmptyView() }
  }
}
