import ScreenrKit
import SwiftUI

// The one form for a reply, a comment on an entry, and a new conversation:
// the text field, Contains spoilers, Cancel, and the posting button. It opens
// focused, and Cancel keeps the draft, which its model holds. A failure shows
// beneath the form until the next post.
struct CommentComposer<Context: View>: View {
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
  // The field takes focus as the composer opens, and not again when its
  // screen reappears, such as after a pop or a tab switch: a keyboard that
  // came back as that transition animates could deadlock the app, as one
  // could under a closing sheet (see `keyboardSafeSheet(item:content:)`).
  // The reader taps the field to go on.
  @State private var opening = Opening.pending

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
    .onAppear {
      guard opening == .pending else { return }
      opening = .focused
      focused = true
    }
  }
}

// Whether a composer's field has taken its opening focus.
private enum Opening {
  case pending
  case focused
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
    CommentComposer(
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
        if let label = feed.composerLabel(target, in: entry) {
          Text(label)
            .font(.footnote)
            .foregroundStyle(.muted)
        }
      }
    )
  }
}
