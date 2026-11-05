import ScreenrKit
import SwiftUI

// Signs this iPhone out. The Settings screen presents a failure's alert.
struct SignOutSection: View {
  let settings: SettingsContext

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      SignOutButton(model: settings.models.signOut)
    }
  }
}
