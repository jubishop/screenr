import Foundation
import Observation

// The app's four tabs. Find a title is the search-role tab.
public enum AppTab: String, Hashable, Sendable, CaseIterable {
  case circle
  case friends
  case you
  case find
}

// A sheet over the current tab.
public enum ShellSheet: String, Hashable, Sendable, Identifiable {
  // The bell's notifications.
  case notifications
  // Account settings, from the You tab's gear.
  case settings

  public var id: Self { self }
}

// Where the app is: the selected tab, each tab's navigation stack, and the
// sheet over them. Views push destinations onto a tab's stack with
// `NavigationLink(value:)`; links from outside the app, such as universal
// links and notifications, arrive through `open(_:)`.
@MainActor
@Observable
public final class Router {
  public var selectedTab: AppTab = .circle
  // Each tab's stack above its root.
  public var paths: [AppTab: [Destination]] = [:]
  public var sheet: ShellSheet?
  // Where an invitation link's token waits for sign-in and setup to send it.
  public let invitation: PendingInvitation
  // The signed-in member, whose profile is the You tab.
  public var viewerUsername: String?
  // The search and tab a link asked Find a title to show, which its root
  // screen applies. Roots keep their destinations, so their screens persist.
  public private(set) var findSearch: Destination = .search()

  public init(invitation: PendingInvitation = PendingInvitation()) {
    self.invitation = invitation
  }

  // One tab's stack, for `NavigationStack(path: $router[stack: tab])`.
  public subscript(stack tab: AppTab) -> [Destination] {
    get { paths[tab, default: []] }
    set { paths[tab] = newValue }
  }

  // The screen at the bottom of a tab's stack. You is nil until the viewer is
  // known.
  public func root(of tab: AppTab) -> Destination? {
    switch tab {
    case .circle: return .feed()
    case .friends: return .people
    case .find: return .search()
    case .you:
      guard let viewerUsername else { return nil }
      return .profile(username: viewerUsername)
    }
  }

  // Opens a universal link or a `screenr-dev://` link. Returns false for a
  // link that is not Screenr's.
  @discardableResult
  public func open(_ url: URL) -> Bool {
    guard let destination = Destination(url: url) else { return false }
    open(destination)
    return true
  }

  // Shows a destination from outside the current screen:
  //
  // - The friends feed, Find, Friends, and the viewer's own profile select
  //   their tab at its root, and Find shows the link's search. A link to a
  //   feed entry opens the feed at that entry above Circle's root. Account
  //   opens Settings over You.
  // - Invitations and Watch together open in Friends.
  // - Titles, other profiles, conversations, and unknown paths open on the
  //   current tab.
  // - An invitation link keeps its token for signup.
  //
  // A sheet over the tabs closes, except for Settings.
  public func open(_ destination: Destination) {
    switch destination {
    case .join(let token):
      invitation.open(token)
      return
    case .account:
      show(.you)
      sheet = .settings
      return
    default:
      sheet = nil
    }
    switch destination {
    case .feed(nil, nil):
      show(.circle)
    case .feed:
      show(.circle)
      paths[.circle] = [destination]
    case .search:
      findSearch = destination
      show(.find)
    case .people:
      show(.friends)
    case .invites, .watchTogether:
      show(.friends)
      paths[.friends] = [destination]
    case .profile(let username) where username.lowercased() == viewerUsername?.lowercased():
      show(.you)
    default:
      push(destination)
    }
  }

  // Forgets where the last member was, after they sign out.
  public func reset() {
    selectedTab = .circle
    paths = [:]
    sheet = nil
    viewerUsername = nil
    findSearch = .search()
  }

  private func show(_ tab: AppTab) {
    selectedTab = tab
    paths[tab] = []
  }

  private func push(_ destination: Destination) {
    var stack = paths[selectedTab, default: []]
    // Opening the screen already showing keeps it.
    guard (stack.last ?? root(of: selectedTab)) != destination else { return }
    stack.append(destination)
    paths[selectedTab] = stack
  }
}
