import ScreenrKit
import SwiftUI

// Suggestions and Friends recommend, while no search shows: a picker between
// them, and the chosen list from the screen's read, or its loading or failure.
struct FindListsView: View {
  @Bindable var find: FindModel
  let screen: ScreenModel
  let page: SearchScreen?

  var body: some View {
    Section {
      Picker("Find a title lists", selection: $find.list) {
        Text("Suggestions").tag(FindList.suggestions)
        Text("Friends recommend").tag(FindList.friendsRecommend)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
    }
    switch screen.phase {
    case .loading:
      Section {
        ProgressView("Loading")
          .frame(maxWidth: .infinity)
      }
    case .failed(let error):
      Section {
        Label(error.readExplanation, systemImage: "exclamationmark.triangle")
        Button("Try again") {
          Task { await screen.refresh() }
        }
      }
    case .loaded:
      if let page {
        switch find.list {
        case .suggestions: SuggestionsView(find: find, page: page)
        case .friendsRecommend: FriendsRecommendView(find: find, page: page, screen: screen)
        }
      } else {
        Section {
          Label("This page needs a newer version of Screenr.", systemImage: "arrow.down.app")
        }
      }
    }
  }
}

// Titles from the viewer's circle, each with why it is suggested.
private struct SuggestionsView: View {
  let find: FindModel
  let page: SearchScreen

  var body: some View {
    switch find.suggestions(page) {
    case .nothingYet:
      Section {
        EmptyListMessage(
          title: "No suggestions yet.",
          message: "Search for a title. New choices from your circle will appear here."
        )
      }
    case .listed(let suggestions, let emptyMessage):
      Section {
        ListHeader("From your circle")
        ForEach(suggestions) { suggestion in
          NavigationLink(value: suggestion.destination) {
            SuggestionRow(suggestion: suggestion, serviceIds: page.serviceIds)
          }
        }
        if let emptyMessage {
          Text(emptyMessage)
        }
      }
    }
  }
}

private struct SuggestionRow: View {
  let suggestion: TitleSuggestion
  let serviceIds: [String]

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PosterImage(path: suggestion.title.posterPath, name: suggestion.title.name, width: 56)
      VStack(alignment: .leading, spacing: 4) {
        Text(suggestion.title.name)
          .font(.headline)
        TitleStatusLine(release: suggestion.release, score: suggestion.tmdbScore)
        ViewingLinesView(viewing: suggestion.viewing, serviceIds: serviceIds)
        ForEach(suggestion.reasons, id: \.self) { reason in
          Text(reason)
            .font(.subheadline)
        }
      }
    }
    .padding(.vertical, 4)
  }
}
