import Foundation
import Observation

// Choosing the streaming services a member has, as the web's editor does: a
// search over every service, a selection that saves together, and Clear
// selections. Discovery always includes free options as well.
@MainActor
@Observable
public final class StreamingServicesModel {
  public enum State: Hashable, Sendable {
    case editing
    case saving
    case saved
  }

  public let services: [StreamingService]
  public var query = ""
  public private(set) var selected: Set<String>
  public private(set) var state = State.editing
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let onSave: @MainActor () async -> Void

  // Starts with the saved services. `onSave` reads the screen again.
  public init(
    services: [StreamingService],
    saved: [String],
    api: any ScreenrAPI,
    onSave: @escaping @MainActor () async -> Void
  ) {
    self.services = services
    selected = Set(saved)
    self.api = api
    self.onSave = onSave
  }

  // The services whose names contain the search, ignoring case.
  public var visible: [StreamingService] {
    let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !search.isEmpty else { return services }
    return services.filter { $0.name.localizedCaseInsensitiveContains(search) }
  }

  public var canEdit: Bool { state == .editing }

  public func toggle(_ id: String) {
    guard canEdit else { return }
    if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
  }

  public func clear() {
    guard canEdit else { return }
    selected = []
  }

  public func save() async {
    guard canEdit else { return }
    state = .saving
    failure = nil
    // In the order the services are listed, so a save is the same each time.
    let ids = services.map(\.id).filter(selected.contains)
    do {
      _ = try await api.send(.streamingServices(ids))
      await onSave()
      state = .saved
    } catch {
      state = .editing
      if error.kind != .cancelled {
        failure = error.explanation(otherwise: "Your services could not be saved. Try again.")
      }
    }
  }

  // The saved services' names, for the setting's summary.
  public static func summary(services: [StreamingService], saved: [String]) -> String {
    let names = services.filter { saved.contains($0.id) }.map(\.name)
    return names.isEmpty ? "None" : names.joined(separator: ", ")
  }
}
