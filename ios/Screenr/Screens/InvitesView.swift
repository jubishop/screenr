import ScreenrKit
import SwiftUI

// Invitations, `/invites`: create a link for up to 12 signups, share it, and
// revoke it. Settings opens it, and links open it in the Friends tab. The
// chosen limit lives outside the loaded content, so it outlasts a failed read.
struct InvitesView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    InvitationsScreen(
      screen: model,
      invitations: InvitationsModel(api: api) { [model] in await model.refresh() }
    )
  }
}

private struct InvitationsScreen: View {
  let screen: ScreenModel
  @State private var invitations: InvitationsModel
  @State private var revoking: Invitation?

  init(screen: ScreenModel, invitations: InvitationsModel) {
    self.screen = screen
    _invitations = State(initialValue: invitations)
  }

  var body: some View {
    ScreenContent(model: screen) { loaded in
      if case .invites(let page) = loaded.content {
        List {
          create
          if page.invitations.isEmpty {
            Section {
              Text("No active invitations.")
            } header: {
              SectionHeading("Active invitations")
            }
          }
          ForEach(Array(page.invitations.enumerated()), id: \.element.id) { index, invitation in
            InvitationSection(
              invitation: invitation,
              header: index == 0 ? "Active invitations" : nil
            ) {
              revoking = invitation
            }
          }
        }
      }
    }
    .confirmationDialog(
      "Revoke this invitation? Its link will stop working.",
      isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      titleVisibility: .visible,
      presenting: revoking
    ) { invitation in
      Button("Revoke", role: .destructive) {
        Task { await invitations.revoke(invitation) }
      }
      Button("Cancel", role: .cancel) {}
    }
    .onChange(of: invitations.status) { _, status in
      if let status { AccessibilityNotification.Announcement(status).post() }
    }
    .onChange(of: invitations.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }

  private var create: some View {
    Section {
      Stepper(value: $invitations.limit, in: InvitationsModel.signupLimits) {
        LabeledContent("Maximum signups", value: "\(invitations.limit)")
      }
      Button {
        Task { await invitations.create() }
      } label: {
        Label(
          invitations.state == .creating ? "Creating…" : "Create invitation",
          systemImage: "link.badge.plus"
        )
      }
      .disabled(!invitations.canCreate)
    } header: {
      SectionHeading("New invitation")
    } footer: {
      VStack(alignment: .leading, spacing: 6) {
        Text(
          "Invite someone to Screenr. Your link works for 30 days. When someone completes signup through it, you automatically become friends."
        )
        if let failure = invitations.failure {
          FailureLabel(failure)
        } else if let status = invitations.status {
          Text(status)
        }
      }
      .foregroundStyle(.muted)
    }
  }
}

// One active link: its signups and expiry, who joined through it, Share, and
// Revoke.
private struct InvitationSection: View {
  let invitation: Invitation
  let header: String?
  let revoke: () -> Void

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 2) {
        Text("\(invitation.uses) of \(invitation.maxUses) signups")
          .font(.headline)
        Text("Expires \(invitation.expiresAt.formatted(date: .long, time: .omitted))")
          .font(.subheadline)
      }
      .accessibilityElement(children: .combine)
      ForEach(invitation.joined, id: \.username) { person in
        NavigationLink(value: Destination.profile(username: person.username)) {
          Text("Joined: \(person.displayName) (@\(person.username))")
        }
      }
      if let link = invitation.link {
        ShareLink(
          item: link,
          subject: Text("Join me on Screenr"),
          message: Text("Join me on Screenr"),
          preview: SharePreview("Join me on Screenr")
        ) {
          Label("Share invitation link", systemImage: "square.and.arrow.up")
        }
      }
      Button(role: .destructive, action: revoke) {
        DestructiveLabel(title: "Revoke invitation", systemImage: "xmark.circle")
      }
    } header: {
      if let header { SectionHeading(header) }
    }
  }
}
