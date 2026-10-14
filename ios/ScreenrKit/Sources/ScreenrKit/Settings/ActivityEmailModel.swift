import Foundation
import Observation

// The activity email setting. While a change saves, the switch shows the new
// choice and ignores further changes, as on the web.
@MainActor
@Observable
public final class ActivityEmailModel {
  // The choice being saved, shown in place of the saved setting until the
  // save and the screen's next read finish.
  public private(set) var saving: Bool?
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let onSave: @MainActor () async -> Void

  // `onSave` reads the screen again after a change.
  public init(api: any ScreenrAPI, onSave: @escaping @MainActor () async -> Void) {
    self.api = api
    self.onSave = onSave
  }

  // The switch's position, given the saved setting.
  public func isOn(saved: Bool) -> Bool { saving ?? saved }

  public func set(_ enabled: Bool) async {
    guard saving == nil else { return }
    saving = enabled
    failure = nil
    defer { saving = nil }
    do {
      _ = try await api.send(.activityEmail(enabled: enabled))
    } catch {
      if error.kind != .cancelled {
        failure = error.explanation(otherwise: "Your email setting could not be saved. Try again.")
      }
      return
    }
    await onSave()
  }
}
