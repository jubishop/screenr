import ScreenrKit
import SwiftUI

// The All, Movies, and TV filter above a title list, such as Watch together
// or a Want to watch page.
struct TitleKindPicker: View {
  @Binding var filter: TitleKindFilter

  var body: some View {
    Picker("Title type", selection: $filter) {
      ForEach(TitleKindFilter.allCases) { filter in
        Text(filter.label).tag(filter)
      }
    }
    .pickerStyle(.segmented)
    // Segments as wide as their titles, which a full-width control clips.
    .fixedSize()
  }
}
