import SwiftUI

// The "New activity" and "New replies" controls. While other people's
// activity waits behind one, the screen does not move; choosing it shows the
// activity. Track what waits with ScreenrKit's `IncomingActivity`.
enum IncomingActivityKind {
  // New entries or activity in a feed.
  case activity
  // New replies in an open discussion.
  case replies

  fileprivate var title: String {
    switch self {
    case .activity: "New activity"
    case .replies: "New replies"
    }
  }
}

struct IncomingActivityButton: View {
  let kind: IncomingActivityKind
  let count: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("\(kind.title) (\(count))", systemImage: "arrow.up")
        .font(.subheadline.weight(.semibold))
    }
    .buttonStyle(.glass)
    .accessibilityLabel(kind.title)
    .accessibilityValue(Text("\(count)"))
    .accessibilityHint("Shows it without moving what you are reading.")
    .accessibilityIdentifier("incoming-activity")
  }
}

extension View {
  // Floats the control over the top of a scrolling screen while `count` is
  // above zero, so it never moves the content beneath it. `show` applies the
  // waiting activity; keep the reader's place when it changes the content,
  // as `FeedList` does with `scrollPosition(_:anchor:)`.
  func incomingActivity(
    _ kind: IncomingActivityKind,
    count: Int,
    show: @escaping () -> Void
  ) -> some View {
    overlay(alignment: .top) {
      ZStack {
        if count > 0 {
          IncomingActivityButton(kind: kind, count: count, action: show)
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
      }
      // Only the control moves; the activity it shows appears in place.
      .animation(.default, value: count > 0)
    }
  }
}
