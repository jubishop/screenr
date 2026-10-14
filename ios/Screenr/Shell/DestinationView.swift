import ScreenrKit
import SwiftUI

// Shows one destination: the feature screen for its kind, with a model that
// reads and polls its member screen while it is visible. A feature screen
// renders the model's phase, usually through `ScreenContent`, and the shell
// handles polling, pull-to-refresh, the navigation title, and redirects.
struct DestinationView: View {
  let destination: Destination
  @Environment(ShellModel.self) private var shell

  init(_ destination: Destination) {
    self.destination = destination
  }

  // A stack can swap one destination for another in the same place, which
  // would otherwise keep the old screen's model, so each destination gets its
  // own identity and model.
  var body: some View {
    DestinationScreen(destination: destination, shell: shell)
      .id(destination)
  }
}

private struct DestinationScreen: View {
  let destination: Destination
  @State private var model: ScreenModel?

  init(destination: Destination, shell: ShellModel) {
    self.destination = destination
    _model = State(initialValue: shell.screenModel(for: destination))
  }

  var body: some View {
    if let model, let path = model.redirectPath {
      // A redirect, such as an old conversation link's, shows the screen it
      // names in its place; this screen stops polling as it disappears.
      DestinationView(Destination(path: path))
    } else if let model {
      screen(model)
        .navigationTitle(destination.pageName(for: model.screen))
        .livePolling(model)
    } else {
      NotFoundView()
        .navigationTitle(destination.pageName(for: nil))
    }
  }

  // Each destination's feature screen, in its own file under Screens/. A
  // feature replaces its screen's file; this mapping stays one line each.
  @ViewBuilder
  private func screen(_ model: ScreenModel) -> some View {
    switch destination {
    case .feed: FeedView(model: model, destination: destination)
    case .search: FindView(model: model, destination: destination)
    case .people: FriendsView(model: model, destination: destination)
    case .invites: InvitesView(model: model, destination: destination)
    case .account: AccountView(model: model, destination: destination)
    case .watchTogether: WatchTogetherView(model: model, destination: destination)
    case .title: TitleView(model: model, destination: destination)
    case .profile: ProfileView(model: model, destination: destination)
    // An old conversation link always redirects to its entry.
    case .conversation: ScreenContent(model: model) { _ in EmptyView() }
    case .join, .notFound: NotFoundView()
    }
  }
}
