import ScreenrKit
import SwiftUI

// A profile, `/people/<username>`. The viewer's own profile is the root of
// the You tab. Every member who can see the profile gets the person, their
// relationship actions, their top 10, and their friends; only the person and
// their friends get the person's activity, which the server leaves out for
// anyone else, as on the web.
struct ProfileView: View {
  let model: ScreenModel
  let destination: Destination
  // On the viewer's own profile, adds Edit to the Top 10 heading, such as to
  // open the top 10 editor. Nil leaves Edit out.
  var editTopTen: (() -> Void)?
  @Environment(\.screenrAPI) private var api
  @Environment(ShellModel.self) private var shell

  var body: some View {
    ProfilePage(
      model: model,
      feed: FeedModel(api: api) { await model.refresh() },
      actions: ProfileModel(shell: shell) { await model.refresh() },
      editTopTen: editTopTen
    )
  }
}

// The models live here, outside the screen's content, so drafts in the
// activity and the reader's place survive a failed read.
private struct ProfilePage: View {
  let model: ScreenModel
  let editTopTen: (() -> Void)?
  @State private var feed: FeedModel
  @State private var actions: ProfileModel

  init(
    model: ScreenModel,
    feed: FeedModel,
    actions: ProfileModel,
    editTopTen: (() -> Void)?
  ) {
    self.model = model
    self.editTopTen = editTopTen
    _feed = State(initialValue: feed)
    _actions = State(initialValue: actions)
  }

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .profile(let page) = screen.content {
        let profile = page.profile
        let relationship = Relationship(profile, viewer: screen.user.userId)
        FeedList(
          feed: feed,
          snapshot: page.conversations,
          viewer: screen.user,
          emptyMessage: profile.canRead
            ? "Your entries and friends’ discussions will appear here." : nil,
          headerRequests: 0
        ) {
          VStack(alignment: .leading, spacing: 20) {
            ProfileHeader(profile: profile, relationship: relationship, actions: actions)
            TopTenSection(
              entries: page.topTen,
              owner: relationship == .own ? .viewer(edit: editTopTen) : .otherMember
            )
            ProfileFriends(friends: profile.friends)
            if !profile.canRead {
              Text("You’ll see their activity after you become friends.")
                .foregroundStyle(.muted)
                .padding(.horizontal)
            }
          }
          .padding(.vertical)
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            ShareButton(
              destination: .profile(username: profile.person.username),
              subject: profile.person.displayName
            )
          }
          if !relationship.menu.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
              ProfileMenu(person: profile.person, relationship: relationship, actions: actions)
            }
          }
        }
      }
    }
    // The header names the person, so the bar keeps the name small, from
    // the first read on.
    .toolbarTitleDisplayMode(.inline)
  }
}
