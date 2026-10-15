import ScreenrKit
import SwiftUI
import UIKit

// Which notifications reach the member's iPhones as pushes, and whether iOS
// lets Screenr send them to this one: Turn on notifications until the member
// decides, or a way to iOS Settings once they turn them off.
struct PushSettingsSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    let refresh = settings.refresh
    PushSettingsToggles(
      saved: settings.page.pushSettings,
      model: PushSettingsModel(api: api) { await refresh() }
    )
  }
}

private struct PushSettingsToggles: View {
  let saved: PushSettings?
  @State private var model: PushSettingsModel
  @Environment(PushNotifications.self) private var push
  @Environment(\.openURL) private var openURL

  init(saved: PushSettings?, model: PushSettingsModel) {
    self.saved = saved
    _model = State(initialValue: model)
  }

  var body: some View {
    Section {
      switch push.permission {
      case .undecided:
        Button("Turn on notifications", systemImage: "bell.badge") {
          Task { await push.askForPermission() }
        }
      case .denied:
        Button("Open iOS Settings", systemImage: "gear") {
          if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            openURL(url)
          }
        }
      case .allowed, .unknown:
        EmptyView()
      }
      if let saved {
        ForEach(PushKind.allCases, id: \.self) { kind in
          // While a change saves, its switch keeps focus but ignores changes.
          Toggle(
            kind.title,
            isOn: Binding(
              get: { model.isOn(kind, saved: saved) },
              set: { enabled in Task { await model.set(kind, enabled) } }
            )
          )
        }
      }
    } header: {
      SectionHeading("Push notifications")
    } footer: {
      SettingsFooter(text: footer, failure: model.failure)
    }
    // The member may have changed the permission in iOS Settings.
    .task { await push.readPermission() }
  }

  private var footer: String {
    switch push.permission {
    case .denied:
      "Notifications are off for Screenr on this iPhone. Turn on Allow Notifications in iOS Settings to get them."
    case .undecided, .allowed, .unknown:
      "Get a notification on your iPhone as each of these happens."
    }
  }
}

extension PushKind {
  fileprivate var title: String {
    switch self {
    case .friendRequest: "Friend requests"
    case .friendAccepted: "Accepted friend requests"
    case .comment: "Comments on your posts"
    case .reply: "Replies to your comments"
    }
  }
}
