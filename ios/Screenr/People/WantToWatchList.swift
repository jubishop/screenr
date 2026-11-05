import ScreenrKit
import SwiftUI

// A Want to watch page's At home list: the owner, the At home and In
// theaters switch, the All, Movies, and TV filter with its count, a prompt to
// save streaming services, then Ready to watch, why nothing is ready to
// watch, and Availability unknown.
struct WantToWatchList: View {
  let page: WantToWatchScreen
  // The signed-in member's user ID.
  let viewer: String
  // The screen the list is on, which the switch replaces.
  let destination: Destination
  @Binding var filter: TitleKindFilter
  @Environment(ShellModel.self) private var shell

  var body: some View {
    List {
      Section {
        Participants(people: [page.owner])
        Text(page.introduction(viewer: viewer))
        ListModePicker(destination: destination)
        TitleKindPicker(filter: $filter)
        Text(page.count(filter))
          .foregroundStyle(.muted)
        if !page.viewerHasServices {
          Button(WantToWatchScreen.servicesPrompt) {
            shell.router.sheet = .settings
          }
        }
      }
      if let ready = page.section(.available, filter) {
        TitlesSection(section: ready)
      }
      if let empty = page.empty(filter, viewer: viewer) {
        Section {
          VStack(alignment: .leading, spacing: 4) {
            ListHeader(empty.title)
            Text(empty.message)
          }
          if empty.offersFind {
            Button("Find a title") {
              shell.router.open(.search())
            }
          }
        }
      }
      if let unknown = page.section(.unknown, filter) {
        TitlesSection(section: unknown)
      }
      if !page.titles(filter).isEmpty {
        ViewingAttribution()
      }
    }
  }
}

// Ready to watch or Availability unknown: its heading, what it holds, and
// its titles, each with its release status, TMDB user score, and the
// viewer's saved services marked.
private struct TitlesSection: View {
  let section: WantToWatchSection

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 4) {
        ListHeader(section.heading)
        Text(section.description)
          .font(.subheadline)
          .foregroundStyle(.muted)
      }
      ForEach(section.titles) { title in
        NavigationLink(value: WantToWatchScreen.destination(of: title)) {
          TitleRow(
            title: title.title,
            viewing: title.viewing,
            release: title.release,
            score: title.tmdbScore,
            matchingServiceIds: title.matchingServiceIds
          )
        }
      }
    }
  }
}
