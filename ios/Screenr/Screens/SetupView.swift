import ScreenrKit
import SwiftUI

// First-time setup, for a signed-in person without a profile, as on the web:
// a display name and a username, and an optional photo. Joining sends the
// pending invitation, which makes the new member its creator's friend, and
// once it succeeds, `shell.checkAccount()` shows the tabs at Circle.
struct SetupView: View {
  @Environment(\.screenrAPI) private var api
  @Environment(PendingInvitation.self) private var invitation
  @Environment(ShellModel.self) private var shell

  var body: some View {
    SetupForm(
      model: SetupModel(api: api, invitation: invitation) { [shell] in
        await shell.checkAccount()
      }
    )
  }
}

private struct SetupForm: View {
  private enum Field: Hashable {
    case name
    case username
  }

  @State private var model: SetupModel
  @FocusState private var focus: Field?
  @Environment(PendingInvitation.self) private var invitation

  init(model: SetupModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 32) {
        header
        fields
        VStack(alignment: .leading, spacing: 12) {
          Text("Profile photo (optional)")
            .font(.headline)
            .accessibilityAddTraits(.isHeader)
          ProfilePhotoEditor(model: model.photo, name: model.name)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        join
        SignOutButton()
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 40)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color(uiColor: .systemBackground))
    .task { await model.load() }
    .onChange(of: model.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }

  private var header: some View {
    VStack(spacing: 12) {
      Wordmark()
      Text("What should friends call you?")
        .font(.title2.weight(.bold))
        .accessibilityAddTraits(.isHeader)
      Text(
        "Two details, and you’re in. Joining through a member’s invitation automatically makes you friends with them."
      )
      if invitation.status == .unavailable {
        notice("That invitation is no longer available. Ask for a new link.")
      }
    }
    .multilineTextAlignment(.center)
  }

  private var fields: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 8) {
        Text("Display name")
          .font(.subheadline.weight(.semibold))
          .accessibilityHidden(true)
        TextField("Display name", text: $model.name)
          .textContentType(.name)
          .submitLabel(.next)
          .focused($focus, equals: .name)
          .onSubmit { focus = .username }
          .textFieldStyle(.roundedBorder)
      }
      VStack(alignment: .leading, spacing: 8) {
        Text("Username")
          .font(.subheadline.weight(.semibold))
          .accessibilityHidden(true)
        TextField("Username", text: $model.username)
          .textContentType(.username)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.join)
          .focused($focus, equals: .username)
          .onSubmit(submit)
          .textFieldStyle(.roundedBorder)
          .accessibilityHint("3–24 letters, numbers, or underscores.")
        Text("3–24 letters, numbers, or underscores.")
          .font(.footnote)
          .accessibilityHidden(true)
      }
    }
  }

  private var join: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let failure = model.failure { notice(failure) }
      Button(action: submit) {
        ProgressLabel("Join Screenr", busy: model.activity == .joining)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!model.canJoin)
    }
  }

  private func notice(_ text: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.red)
        .accessibilityHidden(true)
      Text(text)
    }
    .font(.callout)
  }

  // Closes the keyboard, so the result shows, and joins.
  private func submit() {
    focus = nil
    Task { await model.join() }
  }
}
