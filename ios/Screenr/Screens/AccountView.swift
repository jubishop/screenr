import ScreenrKit
import SwiftUI

// Settings: the account screen at `/account`, in the sheet that the You tab's
// gear opens. Each section is its own view in Settings/ and takes a
// `SettingsContext`, so a new setting adds its section here in one line.
struct AccountView: View {
  let model: ScreenModel
  let destination: Destination
  @State private var editor: SettingsEditor?

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .account(let page) = screen.content {
        let settings = SettingsContext(
          page: page,
          user: screen.user,
          screen: model,
          open: { editor = $0 }
        )
        List {
          ProfileSection(settings)
          PhotoSection(settings)
          InvitationsSection(settings)
          // Push notification settings go here.
          ActivityEmailSection(settings)
          StreamingServicesSection(settings)
          SignInMethodsSection(settings)
          FeedbackSection(settings)
          SignOutSection(settings)
          DeleteAccountSection(settings)
        }
      }
    }
    .sheet(item: $editor) { editor in
      switch editor {
      case .profile(let model): ProfileEditorSheet(model: model)
      case .streamingServices(let model): StreamingServicesSheet(model: model)
      case .feedback(let model): FeedbackSheet(model: model)
      case .deleteAccount(let model): AccountDeletionSheet(model: model)
      }
    }
  }
}
