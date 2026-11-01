import SwiftUI

// JustWatch's credit beneath a list of titles' viewing options, as a row,
// since a footer is too faint at its size.
struct ViewingAttribution: View {
  var body: some View {
    Section {
      Text(
        "US availability from [JustWatch](https://www.justwatch.com/). Open a title for details."
      )
      .font(.footnote)
    }
  }
}
