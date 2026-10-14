import ScreenrKit
import SwiftUI

// The member's display name and username, with Edit profile.
struct ProfileSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 2) {
        Text(settings.user.displayName)
          .font(.headline)
        Text("@" + settings.user.username)
      }
      .accessibilityElement(children: .combine)
      Button {
        let refresh = settings.refresh
        settings.open(
          .profile(ProfileEditorModel(person: settings.user, api: api) { _ in await refresh() })
        )
      } label: {
        Label("Edit profile", systemImage: "pencil")
      }
    } header: {
      SectionHeading("Your profile")
    }
  }
}

// Edits the display name and username together, as a sheet over Settings.
struct ProfileEditorSheet: View {
  @Bindable var model: ProfileEditorModel
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Display name", text: $model.name)
            .textContentType(.name)
            .submitLabel(.next)
        } header: {
          SectionHeading("Display name")
        }
        Section {
          TextField("Username", text: $model.username)
            .textContentType(.username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit { save() }
        } header: {
          SectionHeading("Username")
        } footer: {
          VStack(alignment: .leading, spacing: 8) {
            if let failure = model.failure { FailureLabel(failure) }
            Text(ProfileEditorModel.usernameHelp)
          }
        }
      }
      .navigationTitle("Edit profile")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
            .disabled(model.state == .saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          if model.state == .saving {
            ProgressView()
              .accessibilityLabel("Saving")
          } else {
            Button("Save", systemImage: "checkmark", role: .confirm) { save() }
              .disabled(!model.canSave)
          }
        }
      }
      .interactiveDismissDisabled(model.state == .saving)
      .onChange(of: model.failure) { _, failure in
        if let failure { AccessibilityNotification.Announcement(failure).post() }
      }
    }
  }

  private func save() {
    Task {
      await model.save()
      guard model.state == .saved else { return }
      AccessibilityNotification.Announcement("Profile saved.").post()
      dismiss()
    }
  }
}
