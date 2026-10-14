import ScreenrKit
import SwiftUI

// Where to watch in the United States: subscription and free services with
// their logos, or why there are none, when the options were last checked,
// TMDB's viewing options page, and the JustWatch and TMDB credits.
struct AvailabilitySection: View {
  let availability: WatchAvailability
  let kind: TitleKind

  private static let justWatch = URL(string: "https://www.justwatch.com/")
  private static let tmdb = URL(string: "https://www.themoviedb.org/")

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      FlowLayout(spacing: 12) {
        Text("Where to watch")
          .font(.title3.bold())
          .accessibilityAddTraits(.isHeader)
        Text("United States")
          .font(.subheadline)
          .foregroundStyle(.muted)
      }
      if let notice = availability.notice {
        Text(notice)
          .foregroundStyle(.muted)
      }
      if availability.status != .unavailable {
        if let empty = availability.emptyMessage {
          Text(empty)
            .foregroundStyle(.muted)
        }
        ForEach(Array(availability.sections.enumerated()), id: \.offset) { _, section in
          VStack(alignment: .leading, spacing: 8) {
            Text(section.label)
              .font(.headline)
              .accessibilityAddTraits(.isHeader)
            ForEach(section.services) { service in
              HStack(spacing: 10) {
                ServiceLogo(path: service.logoPath)
                Text(service.name)
              }
            }
          }
        }
        if kind == .tv {
          Text("Availability may vary by season.")
            .font(.footnote)
            .foregroundStyle(.muted)
        }
        if let checked = availability.checkedLabel() {
          Text(checked)
            .font(.footnote)
            .foregroundStyle(.muted)
        }
      }
      credits
    }
  }

  private var credits: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let link = availability.link, let url = URL(string: link) {
        Link(destination: url) {
          Label("Viewing options on TMDB", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(.feedText)
      }
      if let justWatch = Self.justWatch {
        Link(destination: justWatch) {
          Text("Availability data from JustWatch")
        }
        .buttonStyle(.feedText)
      }
      if let tmdb = Self.tmdb {
        Link(destination: tmdb) {
          Text("Movie and TV details and images from TMDB")
        }
        .buttonStyle(.feedText)
      }
      Text("This product uses the TMDB API but is not endorsed or certified by TMDB.")
        .font(.footnote)
        .foregroundStyle(.muted)
    }
  }
}

// A service's logo from TMDB, or a plain tile while it loads or without one.
// It is decorative: the service's name sits beside it.
private struct ServiceLogo: View {
  let path: String?
  @Environment(\.imageSource) private var images
  @ScaledMetric private var size: CGFloat = 32

  var body: some View {
    AsyncImage(request: images.logo(path)) { phase in
      if case .success(let image) = phase {
        image.resizable().scaledToFit().accessibilityHidden(true)
      } else {
        Color(uiColor: .secondarySystemFill)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: 6))
    .accessibilityHidden(true)
  }
}
