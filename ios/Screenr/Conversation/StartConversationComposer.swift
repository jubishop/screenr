import ScreenrKit
import SwiftUI

// Start a conversation's composer, beneath the screen's heading: a post
// without a title on the friends feed, or a title comment on a title page,
// where a TV show adds optional Season and Episode pickers. Open it with
// `starter.open()` from the screen's Start a conversation button.
struct StartConversationComposer: View {
  let starter: ConversationStarter

  var body: some View {
    CommentComposer(
      label: starter.formLabel,
      fieldLabel: starter.fieldLabel,
      submitLabel: starter.submitLabel,
      text: Binding(get: { starter.draft.body }, set: { starter.setBody($0) }),
      spoiler: Binding(get: { starter.draft.spoiler }, set: { starter.setSpoiler($0) }),
      state: starter.state,
      canPost: starter.canPost,
      post: { Task { await starter.post() } },
      cancel: { starter.cancel() },
      context: {
        Text(starter.explanation)
          .font(.footnote)
          .foregroundStyle(.muted)
        EpisodeLabelPickers(starter: starter)
      }
    )
  }
}

// The optional Season and Episode pickers for a TV title comment. Its label
// reads "Season 2" or "Season 2, Episode 4"; episode names show only here.
private struct EpisodeLabelPickers: View {
  let starter: ConversationStarter

  var body: some View {
    switch starter.seasons {
    case .notNeeded:
      EmptyView()
    case .unavailable:
      Text(starter.seasonNotice ?? "")
        .font(.footnote)
        .foregroundStyle(.muted)
    case .loading, .loaded:
      if starter.seasons != .loaded([]) {
        pickers
      }
    }
  }

  private var pickers: some View {
    VStack(alignment: .leading, spacing: 4) {
      Picker(
        "Season",
        selection: Binding(
          get: { starter.draft.season },
          set: { season in Task { await starter.chooseSeason(season) } }
        )
      ) {
        Text(starter.seasons == .loading ? "Loading seasons…" : "No season").tag(Int?.none)
        ForEach(starter.seasonOptions) { option in
          Text(option.label).tag(Int?.some(option.number))
        }
      }
      .disabled(starter.seasons == .loading)
      if starter.draft.season != nil {
        Picker(
          "Episode",
          selection: Binding(
            get: { starter.draft.episode },
            set: { episode in starter.chooseEpisode(episode) }
          )
        ) {
          Text(episodePlaceholder).tag(Int?.none)
          ForEach(starter.episodeOptions) { option in
            Text(option.label).tag(Int?.some(option.number))
          }
        }
        .disabled(!isLoaded(starter.episodeList))
      }
    }
    .pickerStyle(.menu)
  }

  private var episodePlaceholder: String {
    switch starter.episodeList {
    case .loading, .notNeeded: "Loading episodes…"
    case .unavailable: "Episodes unavailable"
    case .loaded: "Whole season"
    }
  }

  private func isLoaded(_ list: LoadedList<[Episode]>) -> Bool {
    guard case .loaded = list else { return false }
    return true
  }
}
