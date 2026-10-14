import ScreenrKit
import SwiftUI

// Screenr's page in the share sheet: the shared title, with Recommend and
// Want to watch, or a search for it. A member who is signed out of the app,
// or whose build the server no longer accepts, gets the reason instead.
struct ShareView: View {
  let model: ShareModel
  // Closes the share sheet.
  let done: () -> Void
  @Environment(SessionStore.self) private var session

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Screenr")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button(role: .close, action: done)
          }
        }
        .navigationDestination(for: Title.self) { title in
          ShareTitleView(title: title)
        }
    }
  }

  @ViewBuilder private var content: some View {
    switch session.phase {
    case .signedOut:
      ShareMessage(
        title: "Sign in to Screenr",
        systemImage: "person.crop.circle",
        message: "Open Screenr and sign in, then share again."
      )
    case .updateRequired:
      ShareMessage(
        title: "Update Screenr",
        systemImage: "arrow.down.app",
        message:
          "This version of Screenr is no longer supported. Install the latest version to keep using it."
      )
    case .signedIn:
      switch model.phase {
      case .resolving:
        ProgressView("Finding the title…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      case .title(let title):
        ShareTitleView(title: title)
      case .search:
        ShareSearchView(find: model.find)
      case .needsSetup:
        ShareMessage(
          title: "Finish joining Screenr",
          systemImage: "person.crop.circle.badge.plus",
          message: "Open Screenr to set up your profile, then share again."
        )
      case .failed(let message):
        ShareMessage(
          title: "Could not find the title",
          systemImage: "exclamationmark.triangle",
          message: message
        ) {
          Button("Try again") { Task { await model.resolve() } }
            .buttonStyle(.bordered)
          Button("Search for it") { model.search("") }
            .buttonStyle(.bordered)
        }
      }
    }
  }
}

// A search of TMDB's movies and shows, for a share that names no title. It
// starts from the shared text, and each result opens its title.
struct ShareSearchView: View {
  let find: FindModel

  var body: some View {
    List {
      switch find.search {
      case .none:
        Text("Search for the movie or show to save it in Screenr.")
      case .tooShort:
        Label(FindWording.tooShort, systemImage: "exclamationmark.circle")
      case .searching:
        ProgressView("Searching…")
          .frame(maxWidth: .infinity)
      case .failed(_, let message):
        Label(message, systemImage: "exclamationmark.triangle")
      case .found(_, let titles):
        ForEach(titles) { result in
          NavigationLink(value: result.title) {
            ShareTitleRow(title: result.title)
          }
        }
        if let message = find.resultsMessage(titles, serviceIds: nil) {
          Text(message)
        }
      }
    }
    .searchable(
      text: Binding(get: { find.query }, set: { find.edit($0) }),
      placement: .navigationBarDrawer(displayMode: .always),
      prompt: "Search movies and TV shows"
    )
    .autocorrectionDisabled()
    .onSubmit(of: .search) { find.submit() }
    .scrollDismissesKeyboard(.immediately)
    .onChange(of: find.search) { _, search in announce(search) }
  }

  // VoiceOver hears how each search ends.
  private func announce(_ search: FindModel.Search) {
    let message: String? =
      switch search {
      case .found: find.searchSummary(serviceIds: nil)
      case .failed(_, let message): message
      case .tooShort: FindWording.tooShort
      case .none, .searching: nil
      }
    if let message { AccessibilityNotification.Announcement(message).post() }
  }
}

// A search result: the poster, the name, and the kind and year.
struct ShareTitleRow: View {
  let title: Title
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    // Large text stacks the poster above the name.
    let layout =
      typeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
      : AnyLayout(HStackLayout(spacing: 12))
    layout {
      SharePoster(title: title, width: 44)
      VStack(alignment: .leading, spacing: 2) {
        Text(title.name)
          .font(.headline)
        Text(title.kindAndYear)
          .font(.subheadline)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

// A title's TMDB poster in its 2:3 frame, or its initial while it loads or
// without one. It is decorative: the title's name sits beside it.
struct SharePoster: View {
  let title: Title
  let width: CGFloat
  @Environment(\.imageSource) private var images
  @ScaledMetric private var scale: CGFloat = 1

  var body: some View {
    AsyncImage(request: images.poster(title.posterPath)) { phase in
      // AsyncImage hosts its content apart, so it is hidden here too.
      if case .success(let image) = phase {
        image.resizable().scaledToFill().accessibilityHidden(true)
      }
    }
    .frame(width: width * scale, height: width * scale * 1.5)
    // The initial sits outside AsyncImage, whose hosted content can escape
    // the hiding below, and shows until a poster covers it.
    .background {
      Text(String(title.name.prefix(1)))
        .font(.title2.weight(.semibold))
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .secondarySystemFill))
    }
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .accessibilityHidden(true)
  }
}

// A centered message with a symbol and any actions, which scrolls at large
// text sizes. The symbol is decorative.
struct ShareMessage<Actions: View>: View {
  let title: String
  let systemImage: String
  let message: String
  @ViewBuilder let actions: () -> Actions

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: 12) {
          Image(systemName: systemImage)
            .font(.largeTitle)
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
          Text(title)
            .font(.title2.bold())
            .accessibilityAddTraits(.isHeader)
          Text(message)
          actions()
            .padding(.top, 8)
        }
        .multilineTextAlignment(.center)
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
      }
    }
  }
}

extension ShareMessage where Actions == EmptyView {
  init(title: String, systemImage: String, message: String) {
    self.init(title: title, systemImage: systemImage, message: message) { EmptyView() }
  }
}
