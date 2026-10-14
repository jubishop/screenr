import AppIntents
import ScreenrKit

// Saves a movie or show to Want to watch, unless the member recommends it or
// has another status for it, which only its page changes. Siri asks which
// title and finds it with Screenr's search.
struct AddToWantToWatchIntent: AppIntent {
  static let title: LocalizedStringResource = "Add to Want to watch"
  static let description = IntentDescription(
    "Saves a movie or show to your Want to watch in Screenr."
  )

  @Parameter(title: "Movie or show", requestValueDialog: "Which movie or show?")
  var item: TitleEntity

  @Dependency private var actions: ShortcutActions

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$item) to Want to watch")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<TitleEntity> & ProvidesDialog {
    let result = try await actions.addToWantToWatch(item.id)
    return .result(value: TitleEntity(result.title), dialog: "\(result.message)")
  }
}

// Names the first movies and shows in Friends recommend, and returns them for
// a shortcut's next action.
struct FriendsRecommendIntent: AppIntent {
  static let title: LocalizedStringResource = "What do my friends recommend?"
  static let description = IntentDescription(
    "Names the first movies and shows in Screenr’s Friends recommend."
  )

  @Dependency private var actions: ShortcutActions

  func perform() async throws -> some IntentResult & ReturnsValue<[TitleEntity]> & ProvidesDialog {
    let summary = try await actions.friendsRecommend()
    return .result(value: summary.titles.map(TitleEntity.init), dialog: "\(summary.message)")
  }
}

// Opens Screenr at Friends recommend in Find a title.
struct OpenFriendsRecommendIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Friends recommend"
  static let description = IntentDescription(
    "Opens Friends recommend in Screenr’s Find a title."
  )
  static let supportedModes: IntentModes = .foreground(.immediate)

  @Dependency private var actions: ShortcutActions

  func perform() async throws -> some IntentResult {
    try await actions.openFriendsRecommend()
    return .result()
  }
}

// The intents Siri and the Shortcuts app offer without any setup.
nonisolated struct ScreenrShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddToWantToWatchIntent(),
      phrases: [
        "Add to Want to watch in \(.applicationName)",
        "Save to Want to watch in \(.applicationName)",
        "Add a movie or show to \(.applicationName)",
      ],
      shortTitle: "Add to Want to watch",
      systemImageName: "bookmark"
    )
    AppShortcut(
      intent: FriendsRecommendIntent(),
      phrases: [
        "What do my friends recommend in \(.applicationName)",
        "What do my friends recommend on \(.applicationName)",
        "What are my friends recommending in \(.applicationName)",
      ],
      shortTitle: "What do my friends recommend?",
      systemImageName: "hand.thumbsup"
    )
    AppShortcut(
      intent: OpenFriendsRecommendIntent(),
      phrases: [
        "Open Friends recommend in \(.applicationName)",
        "Show Friends recommend in \(.applicationName)",
      ],
      shortTitle: "Open Friends recommend",
      systemImageName: "magnifyingglass"
    )
  }
}
