import ScreenrKit
import SwiftUI

// The Friends page's list. Sections follow the web's People page: Requests,
// Friends, Sent requests, People you may know, and Blocked people, beneath
// the exact username search and Invite friends. A result that Block leaves
// for Friends shows first until it is dismissed or the page is left.
struct FriendsList: View {
  let friends: FriendsModel
  let sections: FriendsSections
  @Environment(ShellModel.self) private var shell

  var body: some View {
    List {
      if let notice = shell.notices[.people] {
        Section {
          FriendsNotice(message: notice) {
            shell.dismissNotice(on: .people)
          }
        }
      }
      Section {
        UsernameSearch(friends: friends)
        // A label's symbol column clips its title, so the symbol leads the text.
        NavigationLink(value: Destination.invites) {
          HStack(spacing: 12) {
            Image(systemName: "envelope")
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
            Text("Invite friends")
          }
        }
      }
      if sections.isEmpty {
        Section {
          Text("Start with someone you know. Find their username or send an invitation.")
        }
      }
      if !sections.requests.isEmpty {
        Section {
          PeopleHeading("Requests")
          ForEach(sections.requests) { person in
            PersonActionsRow(person: person, actions: [.accept, .decline], friends: friends)
          }
        }
      }
      if !sections.friends.isEmpty {
        Section {
          PeopleHeading("Friends")
          ForEach(sections.friends) { person in
            NavigationLink(value: Destination.profile(username: person.username)) {
              PersonLabel(person: person)
            }
          }
        }
      }
      if !sections.sent.isEmpty {
        Section {
          PeopleHeading("Sent requests")
          ForEach(sections.sent) { person in
            PersonActionsRow(
              person: person,
              actions: [.cancel],
              friends: friends,
              status: "Request sent"
            )
          }
        }
      }
      Section {
        PeopleHeading("People you may know")
        Text("Meet people through your mutual friends.")
        ForEach(sections.suggestions) { suggestion in
          PersonActionsRow(person: suggestion.person, actions: [.request], friends: friends) {
            MutualFriends(suggestion: suggestion)
          }
        }
        if sections.suggestions.isEmpty {
          Text("No friend suggestions yet.")
            .foregroundStyle(.muted)
        }
      }
      if !sections.blocked.isEmpty {
        Section {
          PeopleHeading("Blocked people")
          ForEach(sections.blocked) { person in
            PersonActionsRow(person: person, actions: [.unblock], friends: friends, link: .unlinked)
          }
        }
      }
    }
    // A notice is for the visit that Block began.
    .onDisappear { shell.dismissNotice(on: .people) }
  }
}

// Opens the profile of an exact username, as the web's search does, or says
// what a username is. The Find button moves beneath the field at
// accessibility sizes.
private struct UsernameSearch: View {
  @Bindable var friends: FriendsModel
  @Environment(ShellModel.self) private var shell
  @Environment(\.dynamicTypeSize) private var size

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Find an exact username")
        .font(.subheadline.weight(.semibold))
      let layout =
        size.isAccessibilitySize
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        : AnyLayout(HStackLayout(spacing: 12))
      layout {
        TextField("Username", text: $friends.username)
          .textFieldStyle(.roundedBorder)
          .textContentType(.username)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.search)
          .onSubmit(find)
        Button("Find", action: find)
          .buttonStyle(.bordered)
      }
      if let problem = friends.searchProblem {
        Text(problem)
          .font(.subheadline)
          .foregroundStyle(.danger)
      }
    }
    .padding(.vertical, 4)
  }

  private func find() {
    if let destination = friends.find() {
      shell.router.open(destination)
    } else if let problem = friends.searchProblem {
      AccessibilityNotification.Announcement(problem).post()
    }
  }
}

// A person with the actions their section offers, such as Accept and
// Decline, and their last failed action's message.
private struct PersonActionsRow<Note: View>: View {
  enum Link {
    case profile
    // Blocking hides the profile, so a blocked person shows only their name.
    case unlinked
  }

  let person: Person
  let actions: [FriendsModel.Action]
  let friends: FriendsModel
  var status: String?
  var link = Link.profile
  @ViewBuilder var note: () -> Note

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      switch link {
      case .profile:
        NavigationLink(value: Destination.profile(username: person.username)) {
          PersonLabel(person: person)
        }
      case .unlinked:
        PersonLabel(person: person, detail: .nameOnly)
      }
      note()
      HStack(spacing: 12) {
        if let status {
          Text(status)
            .font(.subheadline)
            .foregroundStyle(.muted)
        }
        ForEach(actions, id: \.self) { action in
          button(action)
        }
      }
      if let failure = friends.failure(for: person) {
        Text(failure)
          .font(.subheadline)
          .foregroundStyle(.danger)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("person-\(person.username)")
  }

  @ViewBuilder
  private func button(_ action: FriendsModel.Action) -> some View {
    let sending = friends.isPending(action, for: person)
    let label = PendingLabel(title: action.label, sending: sending)
    switch action {
    case .accept, .request:
      Button {
        Task { await friends.run(action, for: person) }
      } label: {
        label
      }
      .buttonStyle(.borderedProminent)
      .disabled(friends.isSending)
    case .decline:
      // Read while rendering, so asking presents the confirmation.
      let declining = friends.declining == person
      Button {
        friends.askToDecline(person)
      } label: {
        label
      }
      .buttonStyle(.bordered)
      .disabled(friends.isSending)
      .confirmationDialog(
        "Decline \(person.displayName)’s friend request?",
        isPresented: Binding(
          get: { declining },
          set: { if !$0 { friends.cancelDecline() } }
        ),
        titleVisibility: .visible
      ) {
        Button("Decline", role: .destructive) {
          Task { await friends.run(.decline, for: person) }
        }
        Button("Cancel", role: .cancel) { friends.cancelDecline() }
      } message: {
        Text("The request will be removed.")
      }
    case .cancel, .unblock:
      Button {
        Task { await friends.run(action, for: person) }
      } label: {
        label
      }
      .buttonStyle(.bordered)
      .disabled(friends.isSending)
    }
  }
}

extension PersonActionsRow where Note == EmptyView {
  init(
    person: Person,
    actions: [FriendsModel.Action],
    friends: FriendsModel,
    status: String? = nil,
    link: Link = .profile
  ) {
    self.init(person: person, actions: actions, friends: friends, status: status, link: link) {
      EmptyView()
    }
  }
}

// A button's title, with a spinner while its action waits for the server.
struct PendingLabel: View {
  let title: String
  let sending: Bool

  var body: some View {
    HStack(spacing: 6) {
      if sending {
        ProgressView()
      }
      Text(title)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
    .accessibilityValue(sending ? "In progress" : "")
  }
}

// "Mutual friends: Ben Ortiz (@ben), Cam Rivera (@cam)", each name linking
// to their profile.
private struct MutualFriends: View {
  let suggestion: PersonSuggestion

  var body: some View {
    ProfileLinksText(
      prefix: suggestion.mutualFriendsLabel,
      people: suggestion.mutualFriends,
      separator: ", ",
      name: \.nameAndUsername
    )
    .font(.subheadline)
  }
}

// What Block left for Friends, such as "You blocked Ben Ortiz.", which
// VoiceOver reads as it appears.
private struct FriendsNotice: View {
  let message: String
  let dismiss: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(message)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("Dismiss", action: dismiss)
        .buttonStyle(.borderless)
    }
    .onAppear {
      AccessibilityNotification.Announcement(message).post()
    }
  }
}
