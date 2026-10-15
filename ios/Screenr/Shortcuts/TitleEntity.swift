import AppIntents
import ScreenrKit

// A movie or show in Siri and the Shortcuts app. Its ID is the API's title
// ID, such as `tv:201`, which a saved shortcut keeps and reads back from the
// title's page.
nonisolated struct TitleEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(
    name: "Movie or show",
    numericFormat: "\(placeholder: .int) movies and shows"
  )
  static let defaultQuery = TitleQuery()

  let title: TitleSummary

  init(_ title: TitleSummary) {
    self.title = title
  }

  var id: String { title.id }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(title.name)",
      subtitle: "\(title.details)",
      image: DisplayRepresentation.Image(systemName: title.kind == .tv ? "tv" : "film")
    )
  }
}

// Finds movies and shows by name with Screenr's search, and reads a saved
// shortcut's titles from their pages. A picker suggests the titles friends
// recommend that the member could still save to Want to watch.
struct TitleQuery: EntityStringQuery {
  @Dependency private var actions: ShortcutActions

  func entities(for identifiers: [String]) async throws -> [TitleEntity] {
    try await actions.titles(identifiers).map(TitleEntity.init)
  }

  func entities(matching string: String) async throws -> [TitleEntity] {
    try await actions.search(string).map(TitleEntity.init)
  }

  func suggestedEntities() async throws -> [TitleEntity] {
    try await actions.wantToWatchSuggestions().map(TitleEntity.init)
  }
}
