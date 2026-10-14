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

// The model lives here, outside the screen's content, so the search draft
// and an action's result survive a failed read.
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
        FriendsList(friends: friends, sections: FriendsSections(page, viewer: screen.user.userId))
      }
    }
  }
}
