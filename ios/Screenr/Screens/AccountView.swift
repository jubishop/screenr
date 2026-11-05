import ScreenrKit
import SwiftUI

// Settings: the account screen at `/account`, in the sheet that the You tab's
// gear opens. Each section is its own view in Settings/ and takes a
// `SettingsContext`, so a new setting adds its section here in one line.
struct AccountView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    SettingsScreen(model: model, signOut: SignOutModel(api: api))
  }
}

// The editor sheets and the sign-out model live here, outside the screen's
// content, so a failed read, which replaces the sections with the error,
// keeps an open editor with its draft and a sign-out's failure alert.
private struct SettingsScreen: View {
  let model: ScreenModel
  @State private var signOut: SignOutModel
  @State private var editor: SettingsEditor?

  init(model: ScreenModel, signOut: SignOutModel) {
    self.model = model
    _signOut = State(initialValue: signOut)
  }

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .account(let page) = screen.content {
        let settings = SettingsContext(
          page: page,
          user: screen.user,
          screen: model,
          signOut: signOut,
          open: { editor = $0 }
        )
        List {
          ProfileSection(settings)
          PhotoSection(settings)
          InvitationsSection(settings)
          PushSettingsSection(settings)
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
    .signOutFailure(signOut)
  }
}
