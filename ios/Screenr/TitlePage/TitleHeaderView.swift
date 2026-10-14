import ScreenrKit
import SwiftUI

// The top of a title page: the poster, kind and year, name, and synopsis;
// the viewer's Recommend, top 10, status, and review; and which friends
// recommend or want to watch it.
struct TitleHeaderView: View {
  let friends: FriendActivity
  let header: TitleHeader
  let model: TitlePageModel
  // Shows a friend's entry in the feed below.
  let showEntry: (FriendAction) -> Void
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      // Large text stacks the poster above the name.
      let layout =
        typeSize.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
        : AnyLayout(HStackLayout(alignment: .top, spacing: 16))
      layout {
        PosterImage(path: header.title.posterPath, name: header.title.name, width: 110)
        VStack(alignment: .leading, spacing: 4) {
          Text(header.details)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.muted)
          Text(header.title.name)
            .font(.title2.bold())
            .accessibilityAddTraits(.isHeader)
        }
      }
      Text(header.overview)
      TitleActions(header: header, model: model)
      FriendLineView(friends: friends, show: showEntry)
    }
  }
}

// Recommend, the top 10, the watch status, and the review. One write runs at
// a time; a failure shows beneath the buttons. Withdrawing a top 10 title's
// Recommend asks first.
private struct TitleActions: View {
  let header: TitleHeader
  let model: TitlePageModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      FlowLayout {
        Button {
          Task { await model.toggleRecommend(header) }
        } label: {
          Label(header.recommendLabel, systemImage: header.recommended ? "checkmark" : "plus")
        }
        .buttonStyle(.feedAction(chosen: header.recommended))
        .accessibilityAddTraits(header.recommended ? .isSelected : [])
        // Adding also recommends the title; the listed state removes it from
        // the top 10 and keeps the Recommend.
        Button {
          Task { await model.changeTopTen(header) }
        } label: {
          Label(header.topTenLabel, systemImage: header.rank == nil ? "plus" : "checkmark")
        }
        .buttonStyle(.feedAction(chosen: header.rank != nil))
        .accessibilityHint(header.rank == nil ? "" : "Removes it from your top 10.")
        Button {
          model.sheet = .status
        } label: {
          Label(header.statusLabel, systemImage: header.status == nil ? "plus" : "checkmark")
        }
        .buttonStyle(.feedAction(chosen: header.status != nil))
        .accessibilityIdentifier("watch-status")
        .accessibilityHint("Shows the watch statuses.")
        Button {
          model.openReview(header)
        } label: {
          Label(header.reviewLabel, systemImage: header.review == nil ? "star" : "pencil")
        }
        .buttonStyle(.feedAction)
      }
      .disabled(model.write == .saving)
      WriteFailure(message: model.failure?.message)
    }
    .confirmationDialog(
      model.leaving?.message ?? "",
      isPresented: Binding(
        get: { model.leaving != nil && model.sheet == nil },
        set: { presented in if !presented { model.leaving = nil } }
      ),
      titleVisibility: .visible,
      presenting: model.leaving
    ) { leaving in
      Button(leaving.action, role: .destructive) {
        Task { await model.confirm(leaving, for: header) }
      }
      Button("Cancel", role: .cancel) {}
    }
  }
}

// "Recommended by Ben Ortiz (#1)" above "Cam Rivera wants to watch". Each
// name shows that friend's entry below. Hidden when no friend has either
// action. Each group wraps word by word, so VoiceOver reads the line as one
// sentence, before the names' buttons, rather than word by word.
private struct FriendLineView: View {
  let friends: FriendActivity
  let show: (FriendAction) -> Void

  var body: some View {
    if !friends.isEmpty {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(friends.lineGroups.enumerated()), id: \.offset) { _, group in
          FlowLayout(spacing: 0, lineSpacing: 0) {
            ForEach(Array(group.enumerated()), id: \.offset) { _, token in
              switch token {
              case .word(let word):
                Text(word)
                  .font(.subheadline)
                  .accessibilityHidden(true)
              case .name(let friend, let spaced):
                Button {
                  show(friend)
                } label: {
                  Text(friend.displayName + (spaced ? " " : ""))
                }
                .buttonStyle(.feedText)
                .accessibilityLabel(friend.displayName)
                .accessibilityHint("Shows their entry below.")
              }
            }
          }
        }
      }
      .background {
        Color.clear
          .accessibilityElement()
          .accessibilityLabel(friends.sentence)
          .accessibilityAddTraits(.isStaticText)
      }
      .accessibilityElement(children: .contain)
    }
  }
}
