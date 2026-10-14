import ScreenrKit
import SwiftUI

// Signs this iPhone out.
struct SignOutSection: View {
  let settings: SettingsContext

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      SignOutButton()
    }
  }
}
