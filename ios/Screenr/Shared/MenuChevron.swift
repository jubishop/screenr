import SwiftUI

// The down chevron after a control's label or icon that marks it as opening a
// menu of choices, such as the watch status, rather than acting at once like
// the buttons beside it. It is larger and heavier than the label's other
// icons, in the label's color, so it reads at a glance.
struct MenuChevron: View {
  var body: some View {
    Image(systemName: "chevron.down")
      .imageScale(.large)
      .fontWeight(.bold)
      .accessibilityIdentifier("menu-chevron")
  }
}
