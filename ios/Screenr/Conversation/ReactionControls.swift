import ScreenrKit
import SwiftUI

// An entry's or reply's reaction counts, then React, which opens the seven
// reactions in a `ReactionPicker` beneath the line. Choosing the reader's own
// reaction again removes it, and a count does the same as choosing its
// reaction. Place these in an action line, such as a `FlowLayout`, after the
// line's other actions.
struct ReactionControls: View {
  let feed: FeedModel
  let target: ReactionTarget
  let summary: [ReactionSummary]

  var body: some View {
    let saving = feed.state(of: target) == .saving
    ForEach(ReactionKind.options, id: \.self) { kind in
      if let reaction = summary.first(where: { $0.kind == kind }) {
        Button {
          react(kind)
        } label: {
          Text("\(kind.emoji) \(reaction.count)")
            .monospacedDigit()
        }
        .buttonStyle(.feedAction(chosen: reaction.reacted))
        .disabled(saving)
        .accessibilityLabel(kind.label)
        .accessibilityValue("\(reaction.count)")
        .accessibilityAddTraits(reaction.reacted ? .isSelected : [])
        .accessibilityHint(
          reaction.reacted ? "Removes your \(kind.label) reaction." : "Reacts with \(kind.label)."
        )
      }
    }
    Button {
      feed.togglePicker(for: target)
    } label: {
      Label("React", systemImage: "face.smiling")
    }
    .buttonStyle(.feedAction(chosen: feed.reactionPicker == target))
    .disabled(saving)
    .accessibilityValue(feed.reactionPicker == target ? "Expanded" : "Collapsed")
  }

  private func react(_ kind: ReactionKind) {
    Task { await feed.react(kind, to: target, summary: summary) }
  }
}

// The seven reactions, beneath an action line while its React is open. The
// reader's own reaction shows chosen, and choosing it again removes it.
struct ReactionPicker: View {
  let feed: FeedModel
  let target: ReactionTarget
  let summary: [ReactionSummary]

  var body: some View {
    if feed.reactionPicker == target {
      FlowLayout {
        ForEach(ReactionKind.options, id: \.self) { kind in
          let chosen = summary.contains { $0.kind == kind && $0.reacted }
          Button {
            Task { await feed.react(kind, to: target, summary: summary) }
          } label: {
            Text("\(kind.emoji) \(kind.label)")
          }
          .buttonStyle(.feedAction(chosen: chosen))
          .disabled(feed.state(of: target) == .saving)
          .accessibilityLabel(kind.label)
          .accessibilityAddTraits(chosen ? .isSelected : [])
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Choose a reaction")
      .accessibilityIdentifier("reaction-picker")
    }
  }
}

// A failed write's message beneath the line whose control started it.
struct WriteFailure: View {
  let message: String?

  var body: some View {
    if let message {
      Text(message)
        .font(.footnote)
        .foregroundStyle(.danger)
        .onAppear { AccessibilityNotification.Announcement(message).post() }
    }
  }
}

extension WriteState {
  var failure: String? {
    guard case .failed(let message) = self else { return nil }
    return message
  }
}
