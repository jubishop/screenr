import Foundation
import Observation

// The signed-in app around the screens: whether the member can use it yet,
// who they are, the bell's unread count, and the router. The app builds one
// and injects it into the environment; feature screens read it with
// `@Environment(ShellModel.self)`.
@MainActor
@Observable
public final class ShellModel {
  public enum Account: Hashable, Sendable {
    // Reading the friends feed to learn whether setup is done.
    case checking
    // A new member who has not chosen a name and username.
    case needsSetup
    case ready
    // The check failed, such as offline. The app offers Try again.
    case failed(APIError)
  }

  public let router: Router
  public private(set) var account: Account = .checking
  // The signed-in member, from the latest screen.
  public private(set) var viewer: Person?
  public private(set) var unreadNotifications = 0
  // Counts the requests for the visible screen to read again, such as when a
  // push notification arrives. Each live screen reads when it changes.
  public private(set) var liveRefreshes = 0
  // Whether the app's scene is active, which live screens poll only while it
  // is. The root view reports it once for every screen, so a screen that
  // appears during a change reads the current value.
  public private(set) var isAppActive = false

  @ObservationIgnored public let api: any ScreenrAPI
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let onViewer: @MainActor (Person) -> Void

  // `onViewer` learns who is signed in each time a new member's first screen
  // loads, such as to name the opaque user ID in error reports.
  public init(
    api: any ScreenrAPI,
    router: Router = Router(),
    clock: any Clock<Duration> = ContinuousClock(),
    onViewer: @escaping @MainActor (Person) -> Void = { _ in }
  ) {
    self.api = api
    self.router = router
    self.clock = clock
    self.onViewer = onViewer
  }

  // Reads the friends feed. A member without a profile gets 403 from every
  // screen, which sends them to setup. Setup calls this again when it is done.
  public func checkAccount() async {
    do throws(APIError) {
      screenLoaded(try await api.send(.screen(path: "/")))
      account = .ready
    } catch {
      switch error.kind {
      case .forbidden: account = .needsSetup
      // The session's phase shows sign-in or the required update.
      case .signedOut, .updateRequired, .cancelled: account = .checking
      default: account = .failed(error)
      }
    }
  }

  // The session ended, by signing out or on the server: the member leaves
  // nothing behind for the next one. The app calls this from
  // `SessionStore.onEnd(_:)`.
  public func sessionEnded() {
    account = .checking
    viewer = nil
    unreadNotifications = 0
    router.reset()
  }

  // A model for a member screen that reports what it loads to the shell, or
  // nil for a destination without a screen.
  public func screenModel(for destination: Destination) -> ScreenModel? {
    guard let path = destination.screenPath else { return nil }
    return ScreenModel(path: path, api: api, clock: clock) { [weak self] screen in
      self?.screenLoaded(screen)
    }
  }

  // Every screen names the reader and their unread notification count.
  public func screenLoaded(_ screen: Screen) {
    let newViewer = viewer?.userId != screen.user.userId
    if viewer != screen.user { viewer = screen.user }
    if newViewer { onViewer(screen.user) }
    if router.viewerUsername != screen.user.username {
      router.viewerUsername = screen.user.username
    }
    if let unread = screen.unreadNotifications { setUnreadNotifications(unread) }
  }

  // Such as after marking notifications read, or from a push's badge.
  public func setUnreadNotifications(_ count: Int) {
    if unreadNotifications != count { unreadNotifications = count }
  }

  // A push notification arrived while the app is open: the visible screen
  // reads again at once.
  public func pushArrived() {
    refreshLiveReads()
  }

  // The visible screen reads again at once, such as after reading
  // notifications, which changes the unread count every screen carries.
  public func refreshLiveReads() {
    liveRefreshes += 1
  }

  public func appActivityChanged(_ isActive: Bool) {
    if isAppActive != isActive { isAppActive = isActive }
  }
}
