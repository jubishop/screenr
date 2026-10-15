import ScreenrKit
import SwiftUI

// Watch together's list: the two people, the All, Movies, and TV filter with
// its count, a prompt to save streaming services, then Ready to watch, Not on
// your services, and Availability unknown, or why nothing shows.
struct WatchTogetherList: View {
  let page: WatchTogetherScreen
  @Binding var filter: WatchTogetherFilter
  @Environment(ShellModel.self) private var shell

  var body: some View {
    List {
      Section {
        Participants(people: page.participants)
        Text(WatchTogetherScreen.introduction)
        Picker("Title type", selection: $filter) {
          ForEach(WatchTogetherFilter.allCases) { filter in
            Text(filter.label).tag(filter)
          }
        }
        .pickerStyle(.segmented)
        // Segments as wide as their titles, which a full-width control clips.
        .fixedSize()
        Text(page.count(filter))
          .foregroundStyle(.muted)
        if !page.viewerHasServices {
          Button(WatchTogetherScreen.servicesPrompt) {
            shell.router.sheet = .settings
          }
        }
      }
      ForEach(page.sections(filter)) { section in
        Section {
          VStack(alignment: .leading, spacing: 4) {
            ListHeader(section.heading)
            Text(section.description)
              .font(.subheadline)
              .foregroundStyle(.muted)
          }
          ForEach(section.titles) { title in
            NavigationLink(value: title.destination) {
              TitleRow(
                title: title.title,
                viewing: title.viewing,
                serviceIds: title.matchingServiceIds,
                savedBy: .eitherPerson
              )
            }
          }
        }
      }
      if let empty = page.empty(filter) {
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
      } else {
        Section {
          Text(
            "US availability from [JustWatch](https://www.justwatch.com/). Open a title for details."
          )
          .font(.footnote)
        }
      }
    }
    // The count is the filter's result, as the web's status line reads.
    .onChange(of: filter) {
      AccessibilityNotification.Announcement(page.count(filter)).post()
    }
  }
}

// "Alice Park & Ben Ortiz", with their photos, each name opening a profile.
// At accessibility sizes the names move beneath the photos. The photos sit
// apart, since an overlapping photo hides part of the other's initial.
private struct Participants: View {
  let people: [Person]
  @Environment(\.dynamicTypeSize) private var size

  var body: some View {
    let layout =
      size.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(spacing: 12))
    layout {
      HStack(spacing: 4) {
        ForEach(people) { person in
          Avatar(person, size: 36)
        }
      }
      ProfileLinksText(people: people, separator: " & ")
        .font(.headline)
    }
  }
}
