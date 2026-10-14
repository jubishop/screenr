import ScreenrKit
import SwiftUI

// Rate or review: five stars with Clear rating, optional text, Contains
// spoilers, and Save review, which needs a rating or text. It starts from the
// saved review, and closing it discards changes. Remove review erases the
// rating and text after a confirmation. A failure keeps the form and draft.
struct ReviewSheet: View {
  let header: TitleHeader
  let model: TitlePageModel

  private var editor: ReviewEditor { model.review }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          StarRating(editor: editor)
          VStack(alignment: .leading, spacing: 6) {
            Text("Your review (optional)")
              .font(.headline)
            TextField(
              "Your review",
              text: Binding(get: { editor.draft.body }, set: { editor.setBody($0) }),
              prompt: Text("What did you think?"),
              axis: .vertical
            )
            .lineLimit(4...12)
            .padding(8)
            .background(
              Color(uiColor: .secondarySystemBackground),
              in: RoundedRectangle(cornerRadius: 8)
            )
          }
          Toggle(
            "Contains spoilers",
            isOn: Binding(get: { editor.draft.spoiler }, set: { editor.setSpoiler($0) })
          )
          FlowLayout(spacing: 12) {
            Button {
              Task { await model.saveReview(for: header) }
            } label: {
              Text(editor.state == .saving ? "Saving…" : "Save review")
            }
            .buttonStyle(.feedAction)
            .disabled(!editor.canSave)
            if header.review != nil {
              Button("Remove review", role: .destructive) {
                editor.step = .confirmingRemoval
              }
              .buttonStyle(.feedAction)
              .disabled(editor.state == .saving)
            }
          }
          WriteFailure(message: editor.state.failure)
        }
        .padding()
      }
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle(header.review == nil ? "Rate or review" : "Edit your review")
      .toolbarTitleDisplayMode(.inline)
      .toolbar { CloseButton() }
      .confirmationDialog(
        "Remove your review? Its rating and text will be erased.",
        isPresented: Binding(
          get: { editor.step == .confirmingRemoval },
          set: { presented in if !presented { editor.step = .editing } }
        ),
        titleVisibility: .visible
      ) {
        Button("Remove", role: .destructive) {
          Task { await model.removeReview(for: header) }
        }
        Button("Cancel", role: .cancel) {}
      }
    }
  }
}

// Five stars, each a choice named for VoiceOver, with Clear rating once one
// is chosen.
private struct StarRating: View {
  let editor: ReviewEditor

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Your rating")
        .font(.headline)
      FlowLayout(spacing: 0) {
        ForEach(1...5, id: \.self) { stars in
          let filled = (editor.draft.rating ?? 0) >= stars
          Button {
            editor.rate(stars)
          } label: {
            Image(systemName: filled ? "star.fill" : "star")
              .font(.title2)
              .foregroundStyle(.tint)
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(stars) star\(stars == 1 ? "" : "s")")
          .accessibilityAddTraits(editor.draft.rating == stars ? .isSelected : [])
        }
        if editor.draft.rating != nil {
          Button("Clear rating") { editor.rate(nil) }
            .buttonStyle(.feedText)
            .padding(.leading, 8)
        }
      }
    }
  }
}
