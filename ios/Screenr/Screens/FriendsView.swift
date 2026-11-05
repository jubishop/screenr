import ScreenrKit
import SwiftUI

// Friends, `/people`, at the root of the Friends tab: finding an exact
// username, Invite friends, requests in both directions, friends, People
// you may know, and blocked people.
struct FriendsView: View {
  let model: ScreenModel
  let destination: Destination
  @Environment(\.screenrAPI) private var api

  var body: some View {
    FriendsScreen(model: model, friends: FriendsModel(api: api) { await model.refresh() })
  }
}

// The model and Decline's confirmation live here, outside the screen's
// content, so the search draft, an action's result, and an open confirmation
// survive a failed read.
private struct FriendsScreen: View {
  let model: ScreenModel
  @State private var friends: FriendsModel

  init(model: ScreenModel, friends: FriendsModel) {
    self.model = model
    _friends = State(initialValue: friends)
  }

  var body: some View {
    ScreenContent(model: model) { screen in
      if case .people(let page) = screen.content {
        let sections = FriendsSections(page, viewer: screen.user.userId)
        FriendsList(friends: friends, sections: sections)
          .onChange(of: sections, initial: true) { _, sections in
            friends.reconcile(with: sections)
          }
      }
    }
    .declineConfirmation(friends)
  }
}
