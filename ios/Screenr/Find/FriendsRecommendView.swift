import ScreenrKit
import SwiftUI

// Titles that direct friends recommend, in the server's order, with Movies/TV
// and Show finished filters. Each title shows who recommends it and one
// action: Want to watch, or the viewer's own status or Recommend, which open
// the title to change.
struct FriendsRecommendView: View {
  @Bindable var find: FindModel
  let page: SearchScreen
  let screen: ScreenModel

  var body: some View {
    if page.recommendations.isEmpty {
      Section {
        EmptyListMessage(
          title: "No recommendations yet.",
          message: "When friends recommend a movie or show, it will appear here."
        )
      }
    } else {
      let list = find.friendsRecommend(page)
      Section {
        Picker("Title type", selection: $find.kindFilter) {
          ForEach(FindModel.KindFilter.allCases, id: \.self) { kind in
            Text(kind.label).tag(kind)
          }
        }
        .pickerStyle(.segmented)
      }
      Section {
        Toggle("Show finished", isOn: showFinished)
        if let message = list.emptyMessage {
          Text(message)
        }
      }
      ForEach(list.titles) { title in
        Section {
          NavigationLink(value: Destination.title(id: title.id)) {
            TitleRow(title: title.title, viewing: title.viewing, serviceIds: page.serviceIds) {
              Text(title.recommendedByText)
                .font(.subheadline)
            }
          }
          RecommendationActionRow(find: find, title: title, screen: screen)
        }
      }
    }
  }

  private var showFinished: Binding<Bool> {
    Binding(
      get: { find.finishedFilter == .shown },
      set: { find.finishedFilter = $0 ? .shown : .hidden }
    )
  }
}

// One tap saves to Want to watch, and tapping again removes it. Another
// status, or the viewer's own Recommend, which Want to watch would replace,
// shows instead and opens the title.
private struct RecommendationActionRow: View {
  let find: FindModel
  let title: FriendsRecommendation
  let screen: ScreenModel

  var body: some View {
    switch title.action {
    case .addWantToWatch, .removeWantToWatch:
      let saved = title.action == .removeWantToWatch
      Button {
        Task { await find.toggleWantToWatch(title) { await screen.refresh() } }
      } label: {
        SymbolText(title.action.label, systemImage: saved ? "checkmark" : "plus")
      }
      .disabled(isSaving)
      .accessibilityLabel("\(title.action.label), \(title.title.name)")
      .accessibilityValue(saved ? "Saved" : "")
      .accessibilityHint(saved ? "Removes it from Want to watch." : "Saves it to Want to watch.")
    case .status, .recommended:
      NavigationLink(value: Destination.title(id: title.id)) {
        SymbolText(title.action.label, systemImage: "checkmark")
      }
      .accessibilityLabel("\(title.action.label), \(title.title.name)")
    }
  }

  private var isSaving: Bool {
    guard case .saving = find.saving else { return false }
    return true
  }
}
