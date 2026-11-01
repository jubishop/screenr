import ScreenrKit
import SwiftUI

// An In theaters list on a Want to watch page or Watch together: the people,
// the introduction, the At home and In theaters switch, and the count, then
// In theaters now or why no movie is in theaters, then Availability unknown.
// Each movie shows its release status and TMDB user score, without viewing
// options, and opens its title page.
struct InTheatersList: View {
  let people: [Person]
  let introduction: String
  let sections: InTheatersSections
  // The screen the list is on, which the switch replaces.
  let destination: Destination
  // The title page each movie opens.
  let open: (ReleaseTitle) -> Destination
  @Environment(ShellModel.self) private var shell

  var body: some View {
    List {
      Section {
        Participants(people: people)
        Text(introduction)
        ListModePicker(destination: destination)
        Text(sections.count)
          .foregroundStyle(.muted)
      }
      if let showing = sections.showing {
        MoviesSection(section: showing, open: open)
      }
      if let empty = sections.empty {
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
      if let unknown = sections.unknown {
        MoviesSection(section: unknown, open: open)
      }
    }
  }
}

// In theaters now or Availability unknown: its heading, what it holds, and
// its movies.
private struct MoviesSection: View {
  let section: InTheatersSection
  let open: (ReleaseTitle) -> Destination

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 4) {
        ListHeader(section.heading)
        Text(section.description)
          .font(.subheadline)
          .foregroundStyle(.muted)
      }
      ForEach(section.titles) { title in
        NavigationLink(value: open(title)) {
          TitleRow(
            title: title.title,
            viewing: nil,
            release: title.release,
            score: title.tmdbScore,
            serviceIds: []
          )
        }
      }
    }
  }
}
