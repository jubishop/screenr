import ScreenrKit
import SwiftUI

// Whether Screenr emails the member about activity they have not read.
struct ActivityEmailSection: View {
  let settings: SettingsContext

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      // While a change saves, the switch keeps focus but ignores changes.
      Toggle(
        "Email me about new activity",
        isOn: Binding(
          get: { model.isOn(saved: settings.page.activityEmail) },
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

  private var model: ActivityEmailModel { settings.models.activityEmail }
}
