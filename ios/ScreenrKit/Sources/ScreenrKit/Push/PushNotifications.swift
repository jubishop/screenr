import Foundation
import Observation

// Push notifications on this iPhone:
//
// - Permission: the app asks only at moments the member can see why, after
//   they join and when they first open the bell, or from Settings. iOS asks
//   once; after that the member decides in iOS Settings.
// - Registration: while the member's tabs show and notifications are
//   allowed, each launch and each return to the foreground asks APNs for the
//   device token and registers it once for the session with `push-device`.
//   Turning notifications off in iOS Settings removes the session's device.
//   Signing out ends the session, which removes its devices on the server.
// - Badge: the app icon shows the unread count the app last read.
// - Taps: a tapped notification opens its item, as selecting it in the bell
//   does, and marks it read. One the member can no longer see opens the bell.
// - Actions: Accept and Decline answer a friend request, and Reply posts a
//   reply to the notification's comment and marks it read, in the
//   background, without opening the app.
// - While open: an arriving push makes the visible screen read again.
@MainActor
@Observable
public final class PushNotifications {
  public private(set) var permission = PushPermission.unknown

  // Whether the member's tabs show. `push-device` needs a profile, so the
  // device registers only then.
  private enum Member {
    case away
    case ready
  }

  private enum Registration: Equatable {
    case none
    case sending(String)
    case registered(String)
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let shell: ShellModel
  @ObservationIgnored private let system: any PushSystem
  @ObservationIgnored private let target: PushTarget
  @ObservationIgnored private var member = Member.away
  // The latest device token from APNs, in lowercase hex.
  @ObservationIgnored private var token: String?
  @ObservationIgnored private var registration = Registration.none
  // The count the app icon shows, as far as the app knows.
  @ObservationIgnored private var badge: Int?
  @ObservationIgnored private(set) var badgeUpdate: Task<Void, Never>?

  public init(
    api: any ScreenrAPI,
    shell: ShellModel,
    system: any PushSystem,
    target: PushTarget
  ) {
    self.api = api
    self.shell = shell
    self.system = system
    self.target = target
    shell.onUnreadCount { [weak self] count in self?.showBadge(count) }
  }

  // The member's tabs show, at launch, after sign-in or setup, or on a
  // return to the foreground: reads the permission, which the member may
  // have changed in iOS Settings, and registers or removes the device.
  public func memberReady() async {
    member = .ready
    // Pushes may have changed the badge while the app was away.
    badge = nil
    await readPermission()
    guard member == .ready else { return }
    switch permission {
    case .allowed:
      system.registerForRemoteNotifications()
      await registerIfNeeded()
    case .denied:
      await removeDevice()
    case .undecided, .unknown:
      break
    }
  }

  public func readPermission() async {
    let permission = await system.permission()
    if self.permission != permission { self.permission = permission }
  }

  // Shows iOS's prompt if the member has not decided yet, and registers the
  // device if they allow notifications.
  public func askForPermission() async {
    if permission == .unknown { await readPermission() }
    guard permission == .undecided else { return }
    do {
      permission = try await system.requestPermission()
    } catch {
      Log.push.warning("The notification permission prompt failed", .error(error))
      await readPermission()
    }
    Log.push.info("Asked for notification permission", .bool("allowed", permission == .allowed))
    if permission == .allowed, member == .ready {
      system.registerForRemoteNotifications()
      await registerIfNeeded()
    }
  }

  // APNs's device token, from the app delegate.
  public func received(token: Data) async {
    self.token =
      token.map { byte in
        let digits = String(byte, radix: 16)
        return byte < 16 ? "0" + digits : digits
      }
      .joined()
    await registerIfNeeded()
  }

  public func registrationFailed(_ error: any Error) {
    Log.push.warning("APNs registration failed", .error(error))
  }

  // The session ended. Its devices went with it on the server; the next
  // member registers again, and sees none of this member's notifications.
  public func sessionEnded() {
    member = .away
    registration = .none
    system.removeDeliveredNotifications()
  }

  // A push arrived while the app is open.
  public func arrived() {
    shell.pushArrived()
  }

  // The member tapped a notification: opens its item on the current tab, or
  // a feed entry on Circle, then marks it read. A notification the member can
  // no longer see, or one that fails to load, opens the bell instead.
  public func open(_ tap: PushTap) async {
    guard let id = tap.notificationID else {
      shell.router.sheet = .notifications
      return
    }
    let notification: PushNotification
    do throws(APIError) {
      switch try await api.send(.notification(id: id)) {
      case .visible(let visible): notification = visible
      case .hidden:
        shell.router.sheet = .notifications
        return
      }
    } catch {
      switch error.kind {
      // The session's phase shows sign-in or the required update.
      case .signedOut, .updateRequired, .cancelled: return
      default: shell.router.sheet = .notifications
      }
      return
    }
    shell.router.open(Destination(path: notification.item.href))
    do throws(APIError) {
      _ = try await api.send(.readNotification(id: id))
      shell.refreshLiveReads()
    } catch {
      Log.push.warning("Marking a tapped notification read failed", .error(error))
    }
  }

  // The member chose one of a notification's actions without opening the
  // app. It returns once the action's requests finish, since iOS keeps a
  // background app running only until then. Nothing opens; the bell and the
  // conversation show the result when they next read.
  public func perform(_ action: PushAction, notificationID: String?) async {
    guard let id = notificationID else {
      Log.push.warning(
        "A notification action named no notification",
        .label("action", action.identifier)
      )
      return
    }
    switch action {
    case .respond(let response): await respond(to: id, response)
    case .reply(let text): await reply(to: id, text)
    }
  }

  // Accept and Decline answer the request as the bell's buttons do, which
  // marks its notification read.
  private func respond(to id: String, _ response: FriendRequestResponse) async {
    let action = PushAction.respond(response).identifier
    do throws(APIError) {
      _ = try await api.send(.respondToFriendRequest(notification: id, response))
    } catch {
      actionFailed(action, error)
      return
    }
    Log.push.info("Answered a friend request from its notification", .label("action", action))
    shell.refreshLiveReads()
  }

  // Reply answers the notification's comment in its conversation, then marks
  // the notification read. A reply that fails leaves it unread in the bell.
  private func reply(to id: String, _ text: String) async {
    guard CommentDraft(body: text).isPostable else {
      Log.push.info("Skipped an empty reply from a notification")
      return
    }
    let notification: PushNotification
    do throws(APIError) {
      switch try await api.send(.notification(id: id)) {
      case .visible(let visible): notification = visible
      case .hidden:
        Log.push.info("A replied notification is no longer visible")
        return
      }
    } catch {
      actionFailed(.reply, error)
      return
    }
    guard let thread = notification.thread, let comment = notification.comment else {
      Log.push.warning("A replied notification names no comment")
      return
    }
    do throws(APIError) {
      _ = try await api.send(
        .comment(conversation: thread, body: text, spoiler: false, replyTo: comment)
      )
    } catch {
      actionFailed(.reply, error)
      return
    }
    Log.push.info("Replied from a notification")
    do throws(APIError) {
      _ = try await api.send(.readNotification(id: id))
    } catch {
      Log.push.warning(
        "Marking a replied notification read failed",
        .error(error),
        .identifier("request_id", error.requestID)
      )
    }
    shell.refreshLiveReads()
  }

  // An action whose request or notification is gone, such as one answered
  // elsewhere or a removed comment, or one while signed out or needing an
  // update, which the session's phase shows, is expected. Other failures are
  // warnings, which reach Sentry.
  private func actionFailed(_ action: PushAction.Identifier, _ error: APIError) {
    switch error.kind {
    case .notFound, .signedOut, .updateRequired:
      Log.push.info(
        "A notification action no longer applies",
        .label("action", action),
        .identifier("request_id", error.requestID)
      )
    default:
      Log.push.warning(
        "A notification action failed",
        .label("action", action),
        .error(error),
        .identifier("request_id", error.requestID)
      )
    }
  }

  private func registerIfNeeded() async {
    guard member == .ready, permission == .allowed, let token else { return }
    guard registration != .sending(token), registration != .registered(token) else { return }
    registration = .sending(token)
    do throws(APIError) {
      _ = try await api.send(
        .registerPushDevice(
          token: token,
          environment: target.environment,
          topic: target.topic,
          build: target.build
        )
      )
      if registration == .sending(token) { registration = .registered(token) }
      Log.push.info("Registered for pushes")
    } catch {
      if registration == .sending(token) { registration = .none }
      Log.push.warning("Push registration failed", .error(error))
    }
  }

  private func removeDevice() async {
    guard case .registered(let token) = registration else { return }
    registration = .none
    do throws(APIError) {
      _ = try await api.send(.removePushDevice(token: token))
      Log.push.info("Removed the device after notifications were turned off")
    } catch {
      // The next return tries again.
      if registration == .none { registration = .registered(token) }
      Log.push.warning("Removing the push device failed", .error(error))
    }
  }

  private func showBadge(_ count: Int) {
    guard badge != count else { return }
    badge = count
    let previous = badgeUpdate
    badgeUpdate = Task { [system] in
      await previous?.value
      do {
        try await system.setBadgeCount(count)
      } catch {
        Log.push.info("Setting the badge failed", .error(error))
      }
    }
  }
}

// What a tapped push names: its notification, from the payload's
// `notificationId`.
public struct PushTap: Hashable, Sendable {
  public let notificationID: String?

  public init(notificationID: String?) {
    self.notificationID = notificationID
  }

  public init(userInfo: [AnyHashable: Any]) {
    notificationID = userInfo["notificationId"] as? String
  }

  // A notification that Screenr Dev opens at launch, as if the member had
  // tapped its push, so UI tests can follow a tap:
  //
  //   -ScreenrPushTap 18
  //
  // Release builds ignore it.
  public static func launch(_ arguments: [String], variant: AppConfiguration.Variant) -> PushTap? {
    guard variant == .dev, let index = arguments.firstIndex(of: "-ScreenrPushTap") else {
      return nil
    }
    let valueIndex = arguments.index(after: index)
    guard arguments.indices.contains(valueIndex) else { return nil }
    return PushTap(notificationID: arguments[valueIndex])
  }
}
