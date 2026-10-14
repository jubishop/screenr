import ScreenrKit
import SwiftUI

// The member's profile photo, with Use my Google photo for a member with a
// Google sign-in, through the editor that setup shares.
struct PhotoSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    PhotoEditorSection(settings: settings, model: ProfilePhotoModel(api: api))
  }
}

private struct PhotoEditorSection: View {
  let settings: SettingsContext
  @State private var model: ProfilePhotoModel

  // What the account screen last said about the photo.
  private struct Reported: Hashable {
    let userId: String
    let version: String?
    let google: Bool
  }

  init(settings: SettingsContext, model: ProfilePhotoModel) {
    self.settings = settings
    _model = State(initialValue: model)
  }

  var body: some View {
    Section {
      ProfilePhotoEditor(model: model, name: settings.user.displayName)
    } header: {
      SectionHeading("Profile photo")
    }
    .task(id: reported) {
      model.show(userId: reported.userId, version: reported.version, google: reported.google)
    }
  }

  private var reported: Reported {
    Reported(
      userId: settings.user.userId,
      version: settings.user.photo,
      google: settings.page.googleConnected
    )
  }
}
