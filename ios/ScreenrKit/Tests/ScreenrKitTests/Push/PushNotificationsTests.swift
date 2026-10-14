import Foundation
import Testing
import UserNotifications

@testable import ScreenrKit

// Push notifications on this iPhone: asking for permission at the moments the
// app chooses, registering the device token for the signed-in session,
// keeping the app icon's badge on the unread count, and opening a tapped
// notification's item.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct PushNotificationsTests {
  private let target = PushTarget(
    environment: .sandbox,
    topic: "com.artisanalsoftware.Screenr.dev",
    build: 42
  )
  private let token = Data([0x5c, 0xe7, 0xe1, 0xd2, 0x00, 0x0f, 0xa0, 0xff])
  private let hex = "5ce7e1d2000fa0ff"
  private let entry = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"

  private func push(
    _ system: RecordingPushSystem,
    api: RecordingAPI = RecordingAPI(["push-device": .success(["ok": true])])
  ) -> (PushNotifications, ShellModel) {
    let shell = ShellModel(api: api, clock: TestClock())
    return (PushNotifications(api: api, shell: shell, system: system, target: target), shell)
  }

  private func register(_ token: String) -> RecordingAPI.Sent {
    RecordingAPI.Sent(
      method: .post,
      action: "push-device",
      query: [:],
      body: [
        "action": "register", "token": .string(token), "environment": "sandbox",
        "topic": "com.artisanalsoftware.Screenr.dev", "build": 42,
      ]
    )
  }

  private func remove(_ token: String) -> RecordingAPI.Sent {
    RecordingAPI.Sent(
      method: .post,
      action: "push-device",
      query: [:],
      body: ["action": "remove", "token": .string(token)]
    )
  }

  // MARK: Registration

  @Test func registersTheDeviceTokenOnceTheMemberIsReady() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, _) = push(system, api: api)

    await push.memberReady()
    #expect(push.permission == .allowed)
    #expect(system.registrations == 1)
    #expect(api.requests.isEmpty)

    // APNs answers through the app delegate.
    await push.received(token: token)

    #expect(api.requests == [register(hex)])
  }

  @Test func registersEachTokenOncePerSession() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, _) = push(system, api: api)
    await push.memberReady()
    await push.received(token: token)

    // Returning to the foreground asks APNs again, which answers the same.
    await push.memberReady()
    await push.received(token: token)
    #expect(api.requests == [register(hex)])
    #expect(system.registrations == 2)

    // A new token replaces the old one.
    await push.received(token: Data([0x01, 0x02]))
    #expect(api.requests == [register(hex), register("0102")])
  }

  @Test func waitsForTheMemberBeforeRegistering() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, _) = push(system, api: api)

    await push.received(token: token)
    #expect(api.requests.isEmpty)

    await push.memberReady()
    #expect(api.requests == [register(hex)])
  }

  // The device's earlier registration ended with the session, so the next
  // member registers it again for theirs.
  @Test func registersAgainForTheNextSession() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, shell) = push(system, api: api)
    await push.memberReady()
    await push.received(token: token)

    shell.sessionEnded()
    push.sessionEnded()
    await push.received(token: token)
    #expect(api.requests == [register(hex)])
    #expect(system.clearedDeliveries == 1)

    await push.memberReady()
    #expect(api.requests == [register(hex), register(hex)])
  }

  @Test func triesAFailedRegistrationAgainOnTheNextReturn() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(
      sequences: ["push-device": [.failure(.offline), .success(["ok": true])]]
    )
    let (push, _) = push(system, api: api)
    await push.memberReady()
    await push.received(token: token)

    await push.memberReady()

    #expect(api.requests == [register(hex), register(hex)])
  }

  @Test func neverRegistersWithoutPermission() async {
    for permission in [PushPermission.undecided, .denied] {
      let system = RecordingPushSystem(permission)
      let api = RecordingAPI(["push-device": .success(["ok": true])])
      let (push, _) = push(system, api: api)

      await push.memberReady()
      await push.received(token: token)

      #expect(push.permission == permission)
      #expect(system.registrations == 0)
      #expect(system.prompts == 0)
      #expect(api.requests.isEmpty)
    }
  }

  // Turning Screenr's notifications off in iOS Settings while the app ran
  // removes this session's device, so the server stops sending to it.
  @Test func removesTheDeviceWhenNotificationsAreTurnedOff() async {
    let system = RecordingPushSystem(.allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, _) = push(system, api: api)
    await push.memberReady()
    await push.received(token: token)

    system.current = .denied
    await push.memberReady()
    #expect(push.permission == .denied)
    #expect(api.requests == [register(hex), remove(hex)])

    // Turning them on again registers the device again.
    system.current = .allowed
    await push.memberReady()
    await push.received(token: token)
    #expect(api.requests == [register(hex), remove(hex), register(hex)])
  }

  // MARK: Permission

  @Test func asksOnlyWhileTheMemberHasNotDecided() async {
    let system = RecordingPushSystem(.undecided, answer: .allowed)
    let api = RecordingAPI(["push-device": .success(["ok": true])])
    let (push, _) = push(system, api: api)
    await push.memberReady()
    #expect(system.prompts == 0)

    await push.askForPermission()
    #expect(system.prompts == 1)
    #expect(push.permission == .allowed)
    #expect(system.registrations == 1)
    await push.received(token: token)
    #expect(api.requests == [register(hex)])

    await push.askForPermission()
    #expect(system.prompts == 1)
  }

  @Test func doesNotAskAgainAfterTheMemberDeclined() async {
    let system = RecordingPushSystem(.undecided, answer: .denied)
    let (push, _) = push(system)

    await push.askForPermission()
    await push.askForPermission()

    #expect(system.prompts == 1)
    #expect(push.permission == .denied)
    #expect(system.registrations == 0)
  }

  @Test func readsThePermissionAgainWhenThePromptFails() async {
    let system = RecordingPushSystem(.undecided, answer: nil)
    let (push, _) = push(system)

    await push.askForPermission()

    #expect(system.prompts == 1)
    #expect(push.permission == .undecided)
  }

  @Test func readsThePermissionForSettings() async {
    let system = RecordingPushSystem(.denied)
    let (push, _) = push(system)
    #expect(push.permission == .unknown)

    await push.readPermission()

    #expect(push.permission == .denied)
    #expect(system.registrations == 0)
  }

  // MARK: Badge

  @Test func keepsTheBadgeOnTheUnreadCountTheAppSees() async {
    let system = RecordingPushSystem(.allowed)
    let (push, shell) = push(system)

    shell.setUnreadNotifications(3)
    await push.badgeUpdate?.value
    shell.setUnreadNotifications(3)
    await push.badgeUpdate?.value
    #expect(system.badges == [3])

    // The first count after a return to the foreground sets the badge, which
    // pushes may have changed meanwhile.
    await push.memberReady()
    shell.setUnreadNotifications(3)
    await push.badgeUpdate?.value
    shell.setUnreadNotifications(1)
    await push.badgeUpdate?.value
    #expect(system.badges == [3, 3, 1])

    // The next member starts without one.
    shell.sessionEnded()
    await push.badgeUpdate?.value
    #expect(system.badges == [3, 3, 1, 0])
  }

  @Test func setsTheBadgeFromTheFirstScreenEvenAtZero() async throws {
    let system = RecordingPushSystem(.allowed)
    let (push, shell) = push(system)

    shell.screenLoaded(try screen("screen/feed/empty"))
    await push.badgeUpdate?.value

    #expect(shell.unreadNotifications == 0)
    #expect(system.badges == [0])
  }

  // MARK: Taps

  @Test func openingANotificationOpensItsItemAndMarksItRead() async throws {
    let api = RecordingAPI([
      "notification": try .fixture("actions/notification/comment"),
      "read-notification": try .fixture("actions/read-notification/default"),
    ])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)
    let refreshes = shell.liveRefreshes

    await push.open(PushTap(notificationID: "18"))

    #expect(
      api.requests == [
        RecordingAPI.Sent(method: .get, action: "notification", query: ["id": "18"], body: nil),
        RecordingAPI.Sent(
          method: .post,
          action: "read-notification",
          query: [:],
          body: ["id": "18"]
        ),
      ]
    )
    #expect(shell.router.selectedTab == .circle)
    #expect(shell.router[stack: .circle] == [.title(id: "tv:201", item: entry, reply: "3")])
    #expect(shell.router.sheet == nil)
    // The screen beneath reads again, which updates the bell's count.
    #expect(shell.liveRefreshes == refreshes + 1)
  }

  @Test func openingAFriendRequestShowsTheirProfileOverTheBell() async throws {
    let api = RecordingAPI([
      "notification": try .fixture("actions/notification/friend-request"),
      "read-notification": .success(["href": "/people/fay"]),
    ])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)
    shell.router.selectedTab = .friends
    shell.router.sheet = .notifications

    await push.open(PushTap(notificationID: "14"))

    #expect(shell.router.sheet == nil)
    #expect(shell.router[stack: .friends] == [.profile(username: "fay")])
    #expect(api.requests.last?.body == ["id": "14"])
  }

  // A notification the member can no longer see, such as after a block,
  // opens the bell instead, and nothing is marked read.
  @Test func openingAHiddenNotificationOpensTheBell() async throws {
    let api = RecordingAPI(["notification": try .fixture("actions/notification/hidden")])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)

    await push.open(PushTap(notificationID: "2"))

    #expect(shell.router.sheet == .notifications)
    #expect(shell.router[stack: .circle].isEmpty)
    #expect(api.requests.map(\.action) == ["notification"])
  }

  @Test func openingANotificationThatFailsToLoadOpensTheBell() async {
    let api = RecordingAPI(["notification": .failure(.offline)])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)

    await push.open(PushTap(notificationID: "18"))

    #expect(shell.router.sheet == .notifications)
    #expect(api.requests.map(\.action) == ["notification"])
  }

  @Test func openingANotificationWhileSignedOutDoesNothing() async {
    let api = RecordingAPI(["notification": .failure(.signedOut)])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)

    await push.open(PushTap(notificationID: "18"))

    #expect(shell.router.sheet == nil)
    #expect(shell.router[stack: .circle].isEmpty)
  }

  @Test func openingAPushWithoutANotificationOpensTheBell() async {
    let api = RecordingAPI()
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)

    await push.open(PushTap(notificationID: nil))

    #expect(shell.router.sheet == .notifications)
    #expect(api.requests.isEmpty)
  }

  @Test func aFailedReadStillShowsTheItem() async throws {
    let api = RecordingAPI([
      "notification": try .fixture("actions/notification/comment"),
      "read-notification": .failure(.server(status: 503)),
    ])
    let (push, shell) = push(RecordingPushSystem(.allowed), api: api)

    await push.open(PushTap(notificationID: "18"))

    #expect(shell.router[stack: .circle] == [.title(id: "tv:201", item: entry, reply: "3")])
    #expect(api.requests.map(\.action) == ["notification", "read-notification"])
  }

  @Test func aPushThatArrivesWhileOpenRefreshesTheScreen() {
    let (push, shell) = push(RecordingPushSystem(.allowed))
    let refreshes = shell.liveRefreshes

    push.arrived()

    #expect(shell.liveRefreshes == refreshes + 1)
  }

  // MARK: Payloads

  // The worker's alert payload names the notification as a string.
  @Test func readsTheNotificationFromThePayload() {
    let userInfo: [AnyHashable: Any] = [
      "aps": [
        "alert": ["body": "New activity on Screenr"], "badge": 3, "sound": "default",
        "mutable-content": 1, "category": "COMMENT", "thread-id": entry,
      ],
      "notificationId": "42",
    ]
    #expect(PushTap(userInfo: userInfo) == PushTap(notificationID: "42"))
    #expect(PushTap(userInfo: ["aps": ["badge": 2]]) == PushTap(notificationID: nil))
    #expect(PushTap(userInfo: ["notificationId": 42]) == PushTap(notificationID: nil))
  }

  @Test func registersTheWorkersCategories() {
    #expect(PushCategory.allCases.map(\.rawValue) == ["FRIEND_REQUEST", "COMMENT"])
    #expect(
      Set(PushCategory.notificationCategories.map(\.identifier)) == ["FRIEND_REQUEST", "COMMENT"]
    )
  }

  @Test func readsALaunchTapOnlyInScreenrDev() {
    let arguments = ["Screenr", "-ScreenrPushTap", "18"]
    #expect(PushTap.launch(arguments, variant: .dev) == PushTap(notificationID: "18"))
    #expect(PushTap.launch(arguments, variant: .release) == nil)
    #expect(PushTap.launch(["Screenr"], variant: .dev) == nil)
    #expect(PushTap.launch(["Screenr", "-ScreenrPushTap"], variant: .dev) == nil)
  }
}
