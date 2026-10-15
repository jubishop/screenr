import Foundation
import Observation

// The notification kinds a member can turn on or off for pushes.
public enum PushKind: String, Hashable, Sendable, CaseIterable {
  case friendRequest
  case friendAccepted
  case comment
  case reply
}

extension PushSettings {
  public func isOn(_ kind: PushKind) -> Bool {
    switch kind {
    case .friendRequest: friendRequest
    case .friendAccepted: friendAccepted
    case .comment: comment
    case .reply: reply
    }
  }
}

// The per-kind push settings, which apply to every iPhone the member signs in
// on. While a kind's change saves, its switch shows the new choice and
// ignores further changes; the other kinds stay usable.
@MainActor
@Observable
public final class PushSettingsModel {
  // The choices being saved, shown in place of the saved settings until each
  // save and the screen's next read finish.
  public private(set) var saving: [PushKind: Bool] = [:]
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let onSave: @MainActor () async -> Void

  // `onSave` reads the screen again after a change.
  public init(api: any ScreenrAPI, onSave: @escaping @MainActor () async -> Void) {
    self.api = api
    self.onSave = onSave
  }

  // A switch's position, given the saved settings.
  public func isOn(_ kind: PushKind, saved: PushSettings) -> Bool {
    saving[kind] ?? saved.isOn(kind)
  }

  public func set(_ kind: PushKind, _ enabled: Bool) async {
    guard saving[kind] == nil else { return }
    saving[kind] = enabled
    failure = nil
    defer { saving[kind] = nil }
    let request: APIRequest<SavedPushSettings> =
      switch kind {
      case .friendRequest: .pushSettings(friendRequest: enabled)
      case .friendAccepted: .pushSettings(friendAccepted: enabled)
      case .comment: .pushSettings(comment: enabled)
      case .reply: .pushSettings(reply: enabled)
      }
    do {
      _ = try await api.send(request)
    } catch {
      if error.kind != .cancelled {
        failure = error.explanation(
          otherwise: "Your notification setting could not be saved. Try again."
        )
      }
      return
    }
    await onSave()
  }
}
