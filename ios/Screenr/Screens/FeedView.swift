import ScreenrKit
import SwiftUI

// The friends feed, `/`, at the root of Circle: the viewer's and friends'
// entries with their discussions, and Start a conversation for a post
// without a title. Its destination can name an entry and reply to show, which
// the screen's `target` confirms.
struct FeedView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    FeedScreen(
      model: model,
      feed: FeedModel(
        api: api,
        refresh: { await model.refresh() },
        showOlder: { await model.showOlder() }
      ),
      starter: ConversationStarter(subject: .post, api: api) { await model.refresh() }
    )
  }
}

// The models and the feed's confirmation live here, outside the screen's
// content, so the reader's drafts and place and an open confirmation survive
// a failed read.
private struct FeedScreen: View {
  let model: ScreenModel
  @State private var feed: FeedModel
  @State private var starter: ConversationStarter
  @State private var composing = 0

  init(model: ScreenModel, feed: FeedModel, starter: ConversationStarter) {
    self.model = model
    _feed = State(initialValue: feed)
    _starter = State(initialValue: starter)
  }

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .feed(let page) = screen.content {
        FeedList(
          feed: feed,
          snapshot: page.conversations,
          viewer: screen.user,
          target: page.target,
          targetUnavailable: page.targetUnavailable,
          emptyMessage: "Your entries and friends’ discussions will appear here.",
          headerRequests: composing,
          history: screen.historyPage
        ) {
          if starter.visibility == .open {
            StartConversationComposer(starter: starter)
              .padding()
          }
        }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              composing += 1
              Task { await starter.open() }
            } label: {
              Label("Start a conversation", systemImage: "square.and.pencil")
            }
          }
        }
      }
    }
    .feedConfirmation(feed)
    .reporting(feed.reports)
  }
}
