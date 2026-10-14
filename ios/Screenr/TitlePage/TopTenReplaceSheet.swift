import ScreenrKit
import SwiftUI

// Adding to a full top 10: the current 10, each a choice to remove. The
// titles below the removed one move up, this title joins at #10, and the
// removed title stays recommended. Closing it changes nothing; a failed
// choice keeps the list open with the reason.
struct TopTenReplaceSheet: View {
  let header: TitleHeader
  let model: TitlePageModel

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(
            "Your top 10 is full. Choose a title to remove; \(header.title.name) joins at #10. The title you remove stays recommended."
          )
          if let failure = model.replaceFailure {
            Text(failure)
              .foregroundStyle(.danger)
          }
        }
        Section {
          ForEach(header.topTen) { entry in
            Button {
              Task { await model.replace(entry, for: header) }
            } label: {
              HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("#\(entry.rank)")
                  .monospacedDigit()
                  .foregroundStyle(.muted)
                Text(entry.name)
                  .foregroundStyle(.primary)
                Spacer()
                Text("Remove")
                  .foregroundStyle(.danger)
              }
              .contentShape(Rectangle())
            }
            .accessibilityIdentifier("replace-\(entry.id)")
          }
        }
      }
      .disabled(model.write == .saving)
      .navigationTitle("Replace a title")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { CloseButton() }
    }
  }
}
