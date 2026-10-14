import ScreenrKit
import SwiftUI

// Whether Screenr emails the member about activity they have not read.
struct ActivityEmailSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    let refresh = settings.refresh
    ActivityEmailToggle(
      saved: settings.page.activityEmail,
      model: ActivityEmailModel(api: api) { await refresh() }
    )
  }
}

private struct ActivityEmailToggle: View {
  let saved: Bool
  @State private var model: ActivityEmailModel

  init(saved: Bool, model: ActivityEmailModel) {
    self.saved = saved
    _model = State(initialValue: model)
  }

  var body: some View {
    Section {
      // While a change saves, the switch keeps focus but ignores changes.
      Toggle(
        "Email me about new activity",
        isOn: Binding(
          get: { model.isOn(saved: saved) },
          set: { enabled in Task { await model.set(enabled) } }
        )
      )
    } header: {
      SectionHeading("Activity emails")
    } footer: {
      SettingsFooter(
        text:
          "Get an email about friend requests, new friendships, comments, and replies. We wait 10 minutes and group notifications you have not read yet.",
        failure: model.failure
      )
    }
  }
}
