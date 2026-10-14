import ScreenrKit
import SwiftUI

// Find a title, `/search`, at the root of the search-role tab. Selecting the
// tab activates the search field. Below it are the My services filter, then
// search results, or Suggestions and Friends recommend. A link's search and
// tab arrive as the router's `findSearch`. The search stays usable when the
// screen's read fails.
struct FindView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    FindScreen(screen: model, find: FindModel(api: api))
  }
}

private struct FindScreen: View {
  let screen: ScreenModel
  @State private var find: FindModel
  @State private var searchPresented = false
  @Environment(ShellModel.self) private var shell

  init(screen: ScreenModel, find: FindModel) {
    self.screen = screen
    _find = State(initialValue: find)
  }

  var body: some View {
    List {
      FindServicesSection(find: find, page: page)
      results
      // A row, since a footer is too faint at its size.
      Section {
        Text(
          "US availability from [JustWatch](https://www.justwatch.com/). Open a title for details."
        )
        .font(.footnote)
      }
    }
    .searchable(
      text: Binding(get: { find.query }, set: { find.edit($0) }),
      isPresented: $searchPresented,
      prompt: "Search movies and TV shows"
    )
    .autocorrectionDisabled()
    .onSubmit(of: .search) { find.submit() }
    // Scrolling the lists or results puts the keyboard away; the search
    // stays.
    .scrollDismissesKeyboard(.immediately)
    .onChange(of: shell.router.selectedTab, initial: true) { _, tab in
      if tab == .find, shell.router[stack: .find].isEmpty { searchPresented = true }
    }
    .onChange(of: shell.router.findSearch, initial: true) { _, link in
      find.apply(link)
    }
    .onChange(of: find.search) { _, search in announce(search) }
    .alert(
      "Could not update Want to watch",
      isPresented: Binding(get: { saveFailure != nil }, set: { _ in find.dismissSaveFailure() }),
      presenting: saveFailure
    ) { _ in
      Button("OK", role: .cancel) { find.dismissSaveFailure() }
    } message: { failure in
      Text(failure)
    }
  }

  // The loaded Find a title screen, or nil while it loads or after a failed
  // read.
  private var page: SearchScreen? {
    guard case .search(let page)? = screen.screen?.content else { return nil }
    return page
  }

  private var saveFailure: String? {
    guard case .failed(let message) = find.saving else { return nil }
    return message
  }

  @ViewBuilder private var results: some View {
    switch find.search {
    case .none, .tooShort:
      if find.search == .tooShort {
        Section {
          Label(FindWording.tooShort, systemImage: "exclamationmark.circle")
        }
      }
      FindListsView(find: find, screen: screen, page: page)
    case .searching:
      Section {
        ProgressView("Searching…")
          .frame(maxWidth: .infinity)
      }
    case .failed(_, let message):
      Section {
        Label(message, systemImage: "exclamationmark.triangle")
      }
    case .found(_, let titles):
      FindResultsSection(find: find, titles: titles, serviceIds: page?.serviceIds)
    }
  }

  // VoiceOver hears how each search ends, as the web's status line says.
  private func announce(_ search: FindModel.Search) {
    let message: String? =
      switch search {
      case .found: find.searchSummary(serviceIds: page?.serviceIds)
      case .failed(_, let message): message
      case .tooShort: FindWording.tooShort
      case .none, .searching: nil
      }
    if let message { AccessibilityNotification.Announcement(message).post() }
  }
}
