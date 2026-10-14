import ScreenrKit
import SwiftUI

// A title page, `/titles/<kind>/<TMDB ID>`: the title's details with the
// viewer's actions and friends' activity, where it streams in the US, its
// trailer, and the discussion around it. Its destination can name an entry
// and reply to show, which the screen's `target` confirms.
struct TitleView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    TitleScreen(
      model: model,
      page: TitlePageModel(api: api, surface: destination.saveSurface ?? .title) {
        await model.refresh()
      },
      feed: FeedModel(api: api) { await model.refresh() },
      starter: ConversationStarter(subject: subject, api: api) { await model.refresh() }
    )
  }

  private var subject: ConversationStarter.Subject {
    guard case .title(let id, _, _, _) = destination else { return .post }
    return .title(id: id, kind: id.hasPrefix("tv:") ? .tv : .movie)
  }
}

// The models and the trailer's player live here, outside the screen's
// content, so drafts, the reader's place, and an open player survive reads.
private struct TitleScreen: View {
  let model: ScreenModel
  @State private var page: TitlePageModel
  @State private var feed: FeedModel
  @State private var starter: ConversationStarter
  @State private var trailer = TrailerPlayer()
  @State private var entryRequest: EntryRequest?

  init(model: ScreenModel, page: TitlePageModel, feed: FeedModel, starter: ConversationStarter) {
    self.model = model
    _page = State(initialValue: page)
    _feed = State(initialValue: feed)
    _starter = State(initialValue: starter)
  }

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .title(let title) = screen.content {
        let header = TitleHeader(title, viewer: screen.user.userId)
        FeedList(
          feed: feed,
          snapshot: title.conversations,
          viewer: screen.user,
          target: title.target,
          targetUnavailable: title.targetUnavailable,
          style: .compact,
          emptyMessage: "Your entries and friends’ discussions will appear here.",
          entryRequest: entryRequest
        ) {
          VStack(alignment: .leading, spacing: 28) {
            TitleHeaderView(friends: title.friends, header: header, model: page) { friend in
              entryRequest = EntryRequest(entry: friend.item)
            }
            AvailabilitySection(availability: title.availability, kind: title.title.kind)
            if let video = title.trailer {
              TrailerSection(title: title.title, trailer: video, player: trailer)
            }
            ConversationHeading(starter: starter)
          }
          .padding()
        }
        .onChange(of: header, initial: true) { _, header in page.reconcile(with: header) }
        .sheet(item: $page.sheet) { sheet in
          TitleSheet(sheet: sheet, header: header, model: page)
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            ShareButton(destination: .title(id: title.title.id), subject: title.title.name)
          }
        }
      }
    }
    // The header names the title, so the bar's title stays small.
    .toolbarTitleDisplayMode(.inline)
  }
}

// "Around this title", with Start a conversation and its composer beneath.
private struct ConversationHeading: View {
  let starter: ConversationStarter

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      FlowLayout(spacing: 12) {
        Text("Around this title")
          .font(.title3.bold())
          .accessibilityAddTraits(.isHeader)
        Button {
          Task { await starter.open() }
        } label: {
          Label("Start a conversation", systemImage: "square.and.pencil")
        }
        .buttonStyle(.feedAction)
      }
      if starter.visibility == .open {
        StartConversationComposer(starter: starter)
      }
    }
  }
}

// The status choices, the review form, or the full top 10's replacement.
private struct TitleSheet: View {
  let sheet: TitlePageModel.Sheet
  let header: TitleHeader
  let model: TitlePageModel

  var body: some View {
    switch sheet {
    case .status: WatchStatusSheet(header: header, model: model)
    case .review: ReviewSheet(header: header, model: model)
    case .replace: TopTenReplaceSheet(header: header, model: model)
    }
  }
}
