import ScreenrKit
import SwiftUI

// The four tabs, each with its own navigation stack, and the sheets over them.
// Find a title is the search-role tab, which sits apart in the tab bar.
struct MainTabView: View {
  @Environment(ShellModel.self) private var shell

  var body: some View {
    @Bindable var router = shell.router
    TabView(selection: $router.selectedTab) {
      Tab("Circle", systemImage: "circle.circle", value: AppTab.circle) {
        TabStack(tab: .circle)
      }
      Tab("Friends", systemImage: "person.2", value: AppTab.friends) {
        TabStack(tab: .friends)
      }
      Tab("You", systemImage: "person.crop.circle", value: AppTab.you) {
        TabStack(tab: .you)
      }
      Tab("Find a title", systemImage: "magnifyingglass", value: AppTab.find, role: .search) {
        TabStack(tab: .find)
      }
    }
    .tabBarMinimizeBehavior(.onScrollDown)
    .sheet(item: $router.sheet) { sheet in
      switch sheet {
      case .notifications: NotificationsSheet()
      case .settings: SettingsSheet()
      }
    }
    // A member with a profile who follows an invitation link lands in Circle,
    // as on the web.
    .onChange(of: router.invitation.token, initial: true) { _, token in
      guard token != nil else { return }
      router.invitation.token = nil
      router.open(.feed())
    }
  }
}

// One tab's navigation stack: its root screen, with the bell and the tab's
// other toolbar buttons, and the destinations pushed above it.
private struct TabStack: View {
  let tab: AppTab
  @Environment(ShellModel.self) private var shell

  var body: some View {
    @Bindable var router = shell.router
    NavigationStack(path: $router[stack: tab]) {
      Group {
        if let root = router.root(of: tab) {
          DestinationView(root)
        }
      }
      .rootToolbar(for: tab)
      .navigationDestination(for: Destination.self) { destination in
        DestinationView(destination)
      }
    }
  }
}
