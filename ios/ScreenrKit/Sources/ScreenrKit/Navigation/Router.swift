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
// links and notifications, arrive through `open(_:)`. A link keeps its place
// until the tabs show it, even when the server ends the session first, and a
// link that names a member waits for a screen to name the viewer.
@MainActor
@Observable
public final class Router {
  public var selectedTab: AppTab = .circle
  // Each tab's stack above its root.
  public var paths: [AppTab: [Destination]] = [:]
  public var sheet: ShellSheet?
  // Where an invitation link's token waits for sign-in and setup to send it.
  public let invitation: PendingInvitation
  // The signed-in member, whose profile is the You tab. Once a screen names
  // them, a link that waited for them opens.
  public var viewerUsername: String? {
    didSet {
      guard viewerUsername != nil, case .awaitingViewer(let link) = pendingLink else { return }
      open(link)
    }
  }
  // The search and tab a link asked Find a title to show, which its root
  // screen applies. Roots keep their destinations, so their screens persist.
  public private(set) var findSearch: Destination = .search()
  // The last destination `open(_:)` received, until its screen loads.
  @ObservationIgnored private var pendingLink: PendingLink?

  private enum PendingLink {
    // A link that names a member, until a screen names the viewer, since the
    // viewer's own pages open in You.
    case awaitingViewer(Destination)
    // A link placed on a tab, with the screen that shows it, such as Find's
    // root for a search.
    case placed(Destination, screen: Destination?)

    var destination: Destination {
      switch self {
      case .awaitingViewer(let destination), .placed(let destination, _): destination
      }
    }

    // Whether a screen that loaded shows the link. A link that names no
    // screen, such as an unknown path, has shown once any screen loads.
    func shown(by loaded: Destination) -> Bool {
      switch self {
      case .awaitingViewer: false
      case .placed(_, let screen): screen?.screenPath == nil || screen == loaded
      }
    }
  }

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
  // - Invitations and Watch together open in Friends, and the viewer's own
  //   Want to watch page opens above You's root.
  // - Titles, other profiles, conversations, and unknown paths open on the
  //   current tab.
  // - An invitation link keeps its token for signup and opens Circle, where a
  //   member who already has a profile lands, as on the web.
  //
  // A sheet over the tabs closes, except for Settings. The link waits until
  // its screen loads; see `sessionEnded(_:)`. Until a screen names the
  // viewer, such as at launch or after the session expired, a link to a
  // profile or a Want to watch page waits for them before it opens.
  public func open(_ destination: Destination) {
    switch destination {
    case .profile where viewerUsername == nil, .wantToWatch where viewerUsername == nil:
      pendingLink = .awaitingViewer(destination)
      return
    case .join(let token):
      invitation.open(token)
      open(.feed())
      return
    case .account:
      show(.you)
      sheet = .settings
      pendingLink = .placed(destination, screen: .account)
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
    case .wantToWatch(let username) where username.lowercased() == viewerUsername?.lowercased():
      show(.you)
      paths[.you] = [destination]
    default:
      push(destination)
    }
    let screen = paths[selectedTab, default: []].last ?? root(of: selectedTab)
    pendingLink = .placed(destination, screen: screen)
  }

  // A screen loaded for the signed-in member, so a link it shows has reached
  // them.
  public func screenLoaded(_ destination: Destination) {
    if pendingLink?.shown(by: destination) == true { pendingLink = nil }
  }

  // Closes destinations that no longer load, such as a blocked person's
  // profile, with whatever each tab opened above them.
  public func close(where isClosed: (Destination) -> Bool) {
    for (tab, stack) in paths {
      guard let index = stack.firstIndex(where: isClosed) else { continue }
      paths[tab] = Array(stack[..<index])
    }
  }

  // Forgets where the last member was once their session ends. When the
  // server ended it, such as after it expired, a link whose screen had not
  // loaded yet opens again for the next sign-in: the member may have just
  // followed it into the 401. Signing out or deleting the account forgets
  // the link too.
  public func sessionEnded(_ ending: SessionStore.Ending) {
    let link = ending == .expired ? pendingLink?.destination : nil
    selectedTab = .circle
    paths = [:]
    sheet = nil
    viewerUsername = nil
    findSearch = .search()
    pendingLink = nil
    if let link { open(link) }
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
