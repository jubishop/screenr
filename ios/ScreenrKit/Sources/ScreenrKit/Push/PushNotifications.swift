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
//   While they are off in iOS Settings, the app asks APNs for the token all
//   the same, which APNs issues regardless, and removes the device once per
//   launch, since an earlier launch may have registered it. Signing out ends
//   the session, which removes its devices on the server.
// - Badge: the app icon shows the unread count the app last read.
// - Session end: the badge and Notification Center clear. A launch without a
//   session clears them too, since the session may have ended in an
//   extension.
// - Taps: a tapped notification opens its item, as selecting it in the bell
//   does, and marks it read. One the member can no longer see opens the bell.
// - Actions: Accept and Decline answer a friend request, and Reply posts a
//   reply to the notification's comment and marks it read, in the
//   background, without opening the app. One that fails for a reason that
//   may pass posts an alert in its place, which opens the notification again,
//   with a reply's text kept for its composer.
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

  // What this launch knows of the device on the server for the session.
  private enum Registration: Equatable {
    case none
    case sending(String)
    case registered(String)
    case removing(String)
    case removed(String)
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

  // `session` says whether this launch has one.
  public init(
    api: any ScreenrAPI,
    shell: ShellModel,
    system: any PushSystem,
    target: PushTarget,
    session: SessionStore
  ) {
    self.api = api
    self.shell = shell
    self.system = system
    self.target = target
    shell.onUnreadCount { [weak self] count in self?.showBadge(count) }
    // An extension that got 401 removed the token and ran no end handler
    // here, so the last member's badge and notifications may remain.
    if session.phase == .signedOut {
      showBadge(0)
      system.removeDeliveredNotifications()
    }
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
    case .allowed, .denied:
      system.registerForRemoteNotifications()
      await updateDevice()
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
    await updateDevice()
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
    // The alert of a reply that did not post opens its composer with the text.
    if let reply = tap.unpostedReply, let thread = notification.thread,
      let comment = notification.comment
    {
      shell.keepReply(reply, for: .reply(entry: thread, comment: comment))
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
    let action = PushAction.respond(response)
    do throws(APIError) {
      _ = try await api.send(.respondToFriendRequest(notification: id, response))
    } catch {
      await actionFailed(action, notificationID: id, error)
      return
    }
    Log.push.info(
      "Answered a friend request from its notification",
      .label("action", action.identifier)
    )
    shell.refreshLiveReads()
  }

  // Reply answers the notification's comment in its conversation, then marks
  // the notification read. A reply that fails leaves it unread in the bell.
  // The server counts the trimmed text's UTF-16 code units, so a longer reply
  // is never sent.
  private func reply(to id: String, _ text: String) async {
    guard CommentDraft(body: text).isPostable else {
      Log.push.info("Skipped an empty reply from a notification")
      return
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.utf16.count <= CommentDraft.maximumLength else {
      Log.push.info("A reply from a notification was too long to post")
      await post(
        FailedActionAlert(
          notificationID: id,
          action: .reply(text),
          body: "Replies can have up to 2,000 characters."
        )
      )
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
      await actionFailed(.reply(text), notificationID: id, error)
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
      await actionFailed(.reply(text), notificationID: id, error)
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
  // warnings, which reach Sentry, and post an alert in the action's place,
  // since the member may try again.
  private func actionFailed(
    _ action: PushAction,
    notificationID: String,
    _ error: APIError
  ) async {
    switch error.kind {
    case .notFound, .signedOut, .updateRequired:
      Log.push.info(
        "A notification action no longer applies",
        .label("action", action.identifier),
        .identifier("request_id", error.requestID)
      )
    default:
      Log.push.warning(
        "A notification action failed",
        .label("action", action.identifier),
        .error(error),
        .identifier("request_id", error.requestID)
      )
      await post(FailedActionAlert(notificationID: notificationID, action: action, error: error))
    }
  }

  private func post(_ alert: FailedActionAlert) async {
    do {
      try await system.post(alert)
    } catch {
      Log.push.warning(
        "Posting a failed action's alert failed",
        .label("action", alert.action.identifier),
        .error(error)
      )
    }
  }

  // Registers the device while notifications are allowed and removes it
  // while they are off.
  private func updateDevice() async {
    switch permission {
    case .allowed: await registerIfNeeded()
    case .denied: await removeIfNeeded()
    case .undecided, .unknown: break
    }
  }

  private func registerIfNeeded() async {
    guard member == .ready, permission == .allowed, let token else { return }
    let busy: [Registration] = [.sending(token), .registered(token), .removing(token)]
    guard !busy.contains(registration) else { return }
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

  // Removes the device this launch registered, or else the one APNs's
  // token names, which an earlier launch may have registered for the
  // session. A registration in flight is removed on the next return.
  private func removeIfNeeded() async {
    guard member == .ready, permission == .denied else { return }
    let removing: String
    switch registration {
    case .registered(let registered):
      removing = registered
    case .none, .removed:
      guard let token, registration != .removed(token) else { return }
      removing = token
    case .sending, .removing:
      return
    }
    let previous = registration
    registration = .removing(removing)
    do throws(APIError) {
      _ = try await api.send(.removePushDevice(token: removing))
      if registration == .removing(removing) { registration = .removed(removing) }
      Log.push.info("Removed the device while notifications are off")
    } catch {
      // The next return tries again.
      if registration == .removing(removing) { registration = previous }
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
// `notificationId`, and for the alert of a reply that did not post, the
// reply's text.
public struct PushTap: Hashable, Sendable {
  static let notificationKey = "notificationId"
  static let unpostedReplyKey = "unpostedReply"

  public let notificationID: String?
  public let unpostedReply: String?

  public init(notificationID: String?, unpostedReply: String? = nil) {
    self.notificationID = notificationID
    self.unpostedReply = unpostedReply
  }

  public init(userInfo: [AnyHashable: Any]) {
    notificationID = userInfo[Self.notificationKey] as? String
    unpostedReply = userInfo[Self.unpostedReplyKey] as? String
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
