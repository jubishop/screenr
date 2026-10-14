import ScreenrKit
import SwiftUI

// The one form for a reply, a comment on an entry, and a new conversation:
// the text field, Contains spoilers, Cancel, and the posting button. It opens
// focused, and Cancel keeps the draft, which its model holds. A failure shows
// beneath the form until the next post.
struct CommentComposer<Context: View>: View {
  // Names the form for VoiceOver, such as "Replying to @ben".
  let label: String
  // The text field's name, such as "Add your reply".
  let fieldLabel: String
  let submitLabel: String
  @Binding var text: String
  @Binding var spoiler: Bool
  let state: WriteState
  let canPost: Bool
  let post: () -> Void
  let cancel: () -> Void
  // Shown above the field, such as the reply's destination or season pickers.
  @ViewBuilder var context: () -> Context
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      context()
      TextField(fieldLabel, text: $text, prompt: Text("What do you think?"), axis: .vertical)
        .lineLimit(3...10)
        .focused($focused)
        .padding(8)
        .background(
          Color(uiColor: .secondarySystemBackground),
          in: RoundedRectangle(cornerRadius: 8)
        )
        .accessibilityLabel(fieldLabel)
      Toggle("Contains spoilers", isOn: $spoiler)
      HStack {
        Button("Cancel", action: cancel)
          .buttonStyle(.feedAction)
        Spacer()
        Button(action: post) {
          Text(state == .saving ? "Posting…" : submitLabel)
        }
        .buttonStyle(PostButtonStyle())
        .disabled(!canPost)
      }
      if case .failed(let message) = state {
        Text(message)
          .font(.footnote)
          .foregroundStyle(.danger)
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(label)
    .onAppear { focused = true }
    .onChange(of: state) { _, state in
      if case .failed(let message) = state {
        AccessibilityNotification.Announcement(message).post()
      }
    }
  }
}

// The composer's posting button: filled with the accent color, or muted
// while there is nothing to post, keeping its text's contrast either way.
private struct PostButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    PostButtonLabel(isPressed: configuration.isPressed) { configuration.label }
  }
}

private struct PostButtonLabel<Label: View>: View {
  let isPressed: Bool
  @ViewBuilder let label: () -> Label
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    label()
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(isEnabled ? AnyShapeStyle(.onAccent) : AnyShapeStyle(.muted))
      .padding(.horizontal, 16)
      .frame(minHeight: 44)
      .background(
        Capsule().fill(isEnabled ? Color.accentColor : Color(uiColor: .secondarySystemFill))
      )
      .contentShape(Capsule())
      .opacity(isPressed ? 0.7 : 1)
  }
}

extension CommentComposer where Context == EmptyView {
  init(
    label: String,
    fieldLabel: String,
    submitLabel: String,
    text: Binding<String>,
    spoiler: Binding<Bool>,
    state: WriteState,
    canPost: Bool,
    post: @escaping () -> Void,
    cancel: @escaping () -> Void
  ) {
    self.init(
      label: label,
      fieldLabel: fieldLabel,
      submitLabel: submitLabel,
      text: text,
      spoiler: spoiler,
      state: state,
      canPost: canPost,
      post: post,
      cancel: cancel
    ) { EmptyView() }
  }
}

// A comment or reply composer for one place in an entry's discussion.
struct DiscussionComposer: View {
  let feed: FeedModel
  let target: ComposerTarget
  let entry: FeedEntry

  var body: some View {
    let nested = if case .reply = target { true } else { false }
    let label = feed.composerLabel(target, in: entry)
    CommentComposer(
      label: label,
      fieldLabel: nested ? "Your nested reply" : "Add your reply",
      submitLabel: "Post reply",
      text: Binding(get: { feed.draft(for: target).body }, set: { feed.setBody($0, for: target) }),
      spoiler: Binding(
        get: { feed.draft(for: target).spoiler },
        set: { feed.setSpoiler($0, for: target) }
      ),
      state: feed.state(of: target),
      canPost: feed.canPost(target, in: entry),
      post: { Task { await feed.post(target, in: entry) } },
      cancel: { feed.close(target) },
      context: {
        if nested {
          Text(label)
            .font(.footnote)
            .foregroundStyle(.muted)
        }
      }
    )
  }
}
