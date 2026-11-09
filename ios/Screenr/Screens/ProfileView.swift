import ScreenrKit
import SwiftUI

// A profile, `/people/<username>`. The viewer's own profile is the root of
// the You tab. Every member who can see the profile gets the person, their
// relationship actions, their top 10, and their friends; only the person and
// their friends get the person's activity and a link to their Want to watch
// page, which the server leaves out for anyone else, as on the web.
struct ProfileView: View {
  let model: ScreenModel
  let destination: Destination
  // On the viewer's own profile, adds Edit to the Top 10 heading, such as to
  // open the top 10 editor. Nil leaves Edit out.
  var editTopTen: (() -> Void)?
  @Environment(\.screenrAPI) private var api
  @Environment(ShellModel.self) private var shell

  var body: some View {
    let actions = ProfileModel(shell: shell) { await model.refresh() }
    ProfilePage(
      model: model,
      feed: FeedModel(
        api: api,
        refresh: { await model.refresh() },
        showOlder: { await model.showOlder() },
        // Blocking the person from the offer after a report here closes the
        // profile, as its own Block does.
        reports: ReportModel(api: api, refresh: { await model.refresh() }) { person in
          await actions.block(person, onProfileOf: username)
        }
      ),
      actions: actions,
      editTopTen: editTopTen
    )
  }

  private var username: String {
    guard case .profile(let username) = destination else { return "" }
    return username
  }
}

// The models and the confirmations live here, outside the screen's content,
// so drafts in the activity, the reader's place, and an open confirmation
// survive a failed read.
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
          headerRequests: 0,
          history: screen.historyPage
        ) {
          VStack(alignment: .leading, spacing: 20) {
            ProfileHeader(profile: profile, relationship: relationship, actions: actions)
            TopTenSection(
              entries: page.topTen,
              owner: relationship == .own ? .viewer(edit: editTopTen) : .otherMember
            )
            if profile.canRead {
              ProfileWantToWatchLink(username: profile.person.username)
            }
            ProfileFriends(friends: profile.friends)
            if !profile.canRead {
              Text("You’ll see their activity after you become friends.")
                .foregroundStyle(.muted)
                .padding(.horizontal)
            }
          }
          .padding(.vertical)
        }
        .onChange(of: relationship, initial: true) { _, relationship in
          actions.reconcile(with: relationship)
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
              ProfileMenu(
                person: profile.person,
                relationship: relationship,
                actions: actions,
                reports: feed.reports
              )
            }
          }
        }
      }
    }
    .profileConfirmation(actions)
    .feedConfirmation(feed)
    .reporting(feed.reports)
    // The header names the person, so the bar keeps the name small, from
    // the first read on.
    .toolbarTitleDisplayMode(.inline)
  }
}
