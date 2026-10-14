import ScreenrKit
import SwiftUI

// Deleting the account, last in Settings. Delete account opens a sheet that
// first confirms it's the member with a new sign-in, then asks before
// deleting. Deleting ends the session, so the app returns to sign-in.
struct DeleteAccountSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api
  @Environment(\.identityProviders) private var providers

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    Section {
      Button(role: .destructive) {
        settings.open(
          .deleteAccount(
            AccountDeletionModel(
              api: api,
              member: MemberConfirmation(account: settings.page, viewer: settings.user),
              providers: injectedProviders
            )
          )
        )
      } label: {
        DestructiveLabel(title: "Delete account", systemImage: "trash")
      }
    } header: {
      SectionHeading("Delete account")
    } footer: {
      Text(AccountDeletionSheet.consequences)
        .foregroundStyle(.muted)
    }
  }

  private var injectedProviders: IdentityProviders {
    guard let providers else {
      preconditionFailure("Inject the services with .screenrServices(_:) before deleting")
    }
    return providers
  }
}

// Confirms it's the member with the sign-in screen's methods, then deletes
// the account once they confirm, as a sheet over Settings.
struct AccountDeletionSheet: View {
  static let consequences =
    "Deleting your account erases your profile, photo, friendships, invitations, recommendations, watch statuses, reviews, top 10, reactions, and notifications right away. Your posts, reviews, and comments about titles are removed with their conversations. A comment of yours in someone else’s conversation that has replies becomes “Comment removed” so the replies remain. This can’t be undone."

  let model: AccountDeletionModel
  @State private var asking = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          switch model.step {
          case .verify:
            verify
          case .confirm, .deleting, .deleted:
            confirm
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
        .frame(maxWidth: 480, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .navigationTitle("Delete account")
      .toolbarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
            .disabled(model.step == .deleting)
        }
      }
      .interactiveDismissDisabled(model.step == .deleting)
      .onChange(of: model.failure) { _, failure in
        if let failure { AccessibilityNotification.Announcement(failure).post() }
      }
    }
  }

  @ViewBuilder private var verify: some View {
    Text("First, confirm it’s you by signing in again.")
      .font(.headline)
    if let failure = model.failure { FailureLabel(failure) }
    SignInControls(model: model.signIn)
  }

  @ViewBuilder private var confirm: some View {
    Text("Thanks for confirming it’s you.")
      .font(.headline)
    Text(Self.consequences)
    if let failure = model.failure { FailureLabel(failure) }
    // White on the system's red falls short of 4.5:1, so the button is
    // bordered with `.danger` text, muted while deleting.
    Button(role: .destructive) {
      asking = true
    } label: {
      ProgressLabel(
        "Delete my account",
        systemImage: "trash",
        busy: model.step != .confirm
      )
      .foregroundStyle(model.step == .confirm ? Color.danger : Color.muted)
    }
    .buttonStyle(.bordered)
    .controlSize(.large)
    .disabled(model.step != .confirm)
    .confirmationDialog(
      "Delete your Screenr account permanently?",
      isPresented: $asking,
      titleVisibility: .visible
    ) {
      Button("Delete account", role: .destructive) {
        Task { await model.delete() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This can’t be undone.")
    }
  }
}
