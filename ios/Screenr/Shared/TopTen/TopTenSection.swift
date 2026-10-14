import ScreenrKit
import SwiftUI

// A member's top 10 on their profile: the Top 10 heading and one row of
// numbered posters with their names beneath, each opening its title. The row
// only displays the list; the owner changes it in the editor that Edit
// opens. Another member's empty list shows nothing, and the owner's explains
// how to start one.
struct TopTenSection: View {
  enum Owner {
    // The viewer's own list. `edit` adds Edit to the heading while the list
    // has titles; nil leaves it out.
    case viewer(edit: (() -> Void)?)
    case otherMember
  }

  let entries: [TopTenEntry]
  let owner: Owner

  var body: some View {
    switch (owner, entries.isEmpty) {
    case (.otherMember, true):
      EmptyView()
    case (.viewer, true):
      VStack(alignment: .leading, spacing: 8) {
        heading
        Text("Rank up to 10 titles you recommend. Choose Add to top 10 on a title page to start.")
          .foregroundStyle(.muted)
          .padding(.horizontal)
      }
    case (.viewer(let edit), false):
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          heading
          Spacer(minLength: 8)
          if let edit {
            Button(action: edit) {
              Label("Edit", systemImage: "pencil")
            }
            .accessibilityHint("Reorder or remove titles in your top 10.")
            .padding(.horizontal)
          }
        }
        TopTenRow(entries: entries)
      }
    case (.otherMember, false):
      VStack(alignment: .leading, spacing: 8) {
        heading
        TopTenRow(entries: entries)
      }
    }
  }

  private var heading: some View {
    Text("Top 10")
      .font(.title3.bold())
      .accessibilityAddTraits(.isHeader)
      .padding(.horizontal)
  }
}

// The posters in rank order, scrolling sideways. At most ten, so the row
// lays out every poster, and the tallest name sets its height.
struct TopTenRow: View {
  let entries: [TopTenEntry]

  var body: some View {
    ScrollView(.horizontal) {
      HStack(alignment: .top, spacing: 12) {
        ForEach(entries) { entry in
          NavigationLink(value: Destination.title(id: entry.id)) {
            TopTenPoster(entry: entry)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("#\(entry.rank) \(entry.name)")
        }
      }
      .padding(.horizontal)
    }
    .scrollIndicators(.hidden)
  }
}

// One poster with its rank on a dark badge, which keeps its contrast over any
// poster in both color schemes, and the name beneath.
private struct TopTenPoster: View {
  let entry: TopTenEntry
  @ScaledMetric private var width = 84.0

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      PosterImage(path: entry.posterPath, name: entry.name, width: 84)
        .overlay(alignment: .topLeading) {
          Text("#\(entry.rank)")
            .font(.caption.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.black.opacity(0.8), in: .capsule)
            .padding(4)
        }
      Text(entry.name)
        .font(.footnote)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: width, alignment: .leading)
    }
  }
}
