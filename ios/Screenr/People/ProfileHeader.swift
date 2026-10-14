import ScreenrKit
import SwiftUI

// The top of a profile: the person's photo and @username beneath the
// navigation title's name, and the action their relationship offers: Watch
// together with a friend, or the friend request's next step. A failed
// action's message follows.
struct ProfileHeader: View {
  let profile: Profile
  let relationship: Relationship
  let actions: ProfileModel

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 16) {
        Avatar(profile.person, size: 64)
        VStack(alignment: .leading, spacing: 2) {
          Text(profile.person.displayName)
            .font(.title3.bold())
          Text("@" + profile.person.username)
            .foregroundStyle(.muted)
        }
        .accessibilityElement(children: .combine)
      }
      if let action = relationship.action {
        actionButton(action)
          .controlSize(.large)
      }
      if let failure = actions.failure {
        Text(failure)
          .foregroundStyle(.danger)
      }
    }
    .padding(.horizontal)
  }

  @ViewBuilder
  private func actionButton(_ action: ProfileAction) -> some View {
    let label = PendingLabel(title: action.label, sending: actions.activity != .idle)
    switch action {
    case .watchTogether:
      NavigationLink(value: Destination.watchTogether(with: [profile.person.username])) {
        Text(action.label)
      }
      .buttonStyle(.borderedProminent)
    case .cancelRequest:
      Button {
        Task { await actions.run(action, for: profile.person) }
      } label: {
        label
      }
      .buttonStyle(.bordered)
      .disabled(actions.activity != .idle)
    case .acceptRequest, .sendRequest:
      Button {
        Task { await actions.run(action, for: profile.person) }
      } label: {
        label
      }
      .buttonStyle(.borderedProminent)
      .disabled(actions.activity != .idle)
    }
  }
}

// More actions in the toolbar: Unfriend for a friend, and Block. Each asks
// first, in a confirmation that closes if the friendship ends elsewhere.
struct ProfileMenu: View {
  let person: Person
  let relationship: Relationship
  let actions: ProfileModel

  var body: some View {
    // Read while rendering, so asking presents the confirmation.
    let confirmation = actions.confirmation(for: relationship)
    Menu {
      ForEach(relationship.menu, id: \.self) { item in
        Button(item.label, role: .destructive) {
          actions.ask(item, about: person, relationship)
        }
      }
    } label: {
      Label("More actions", systemImage: "ellipsis")
    }
    .accessibilityLabel("More actions for \(person.displayName)")
    .disabled(actions.activity != .idle)
    .confirmationDialog(
      confirmation?.title ?? "",
      isPresented: Binding(
        get: { confirmation != nil },
        set: { if !$0 { actions.cancelConfirmation() } }
      ),
      titleVisibility: .visible,
      presenting: confirmation
    ) { confirmation in
      Button(confirmation.action, role: .destructive) {
        Task { await actions.confirm(confirmation) }
      }
      Button("Cancel", role: .cancel) { actions.cancelConfirmation() }
    } message: { confirmation in
      Text(confirmation.message)
    }
  }
}

// The person's friends, collapsed beneath a count as on the web, each
// opening their profile. Pending requests stay private.
struct ProfileFriends: View {
  let friends: [Person]
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 12) {
        ForEach(friends) { friend in
          NavigationLink(value: Destination.profile(username: friend.username)) {
            PersonLabel(person: friend)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
        }
        if friends.isEmpty {
          Text("No friends to show yet.")
            .foregroundStyle(.muted)
        }
      }
      .padding(.top, 12)
    } label: {
      Text("Friends (\(friends.count))")
        .font(.headline)
    }
    .padding(.horizontal)
  }
}
