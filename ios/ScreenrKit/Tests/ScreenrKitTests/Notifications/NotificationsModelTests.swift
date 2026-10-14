import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The bell's sheet, against the real client and the fixture API, as the web's
// notification panel behaves: opening reads without marking anything read,
// selecting reads one and opens its item, Mark all as read stops at the
// shown page's boundary, and friend requests are answered in place.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct NotificationsModelTests {
  private let entry = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"

  private func sheet(_ api: NotificationsAPI) -> (NotificationsModel, ShellModel) {
    let shell = ShellModel(api: api, clock: TestClock())
    shell.router.sheet = .notifications
    return (NotificationsModel(shell: shell, clock: TestClock()), shell)
  }

  @Test func readsTheNewestPageWithoutMarkingAnythingRead() async throws {
    let api = try NotificationsAPI()
    let (model, shell) = sheet(api)
    #expect(model.live.phase == .loading)
    #expect(model.rows.isEmpty)

    await model.live.refresh()

    #expect(model.rows.map(\.id) == ["23", "20", "18", "14", "5", "3", "1"])
    #expect(model.rows.filter(\.isUnread).count == 6)
    #expect(model.rows.filter(\.offersAnswer).map(\.id) == ["14"])
    #expect(model.canMarkAllRead)
    #expect(shell.unreadNotifications == 6)
    #expect(api.sent == [.get("notifications")])
  }

  @Test func showsOnlyUnreadNotifications() async throws {
    let api = try NotificationsAPI()
    let (model, _) = sheet(api)
    await model.live.refresh()
    let all = model.live

    model.show(.unread)
    #expect(model.filter == .unread)
    #expect(model.live !== all)
    await model.live.refresh()

    #expect(model.rows.count == 6)
    #expect(model.rows.filter(\.isUnread).count == 6)
    #expect(api.sent == [.get("notifications"), .get("notifications", ["unread": "true"])])

    model.show(.all)
    await model.live.refresh()
    #expect(model.rows.count == 7)
  }

  @Test func selectingOneMarksItReadAndOpensItsItem() async throws {
    let api = try NotificationsAPI()
    let (model, shell) = sheet(api)
    await model.live.refresh()
    let refreshes = shell.liveRefreshes
    let row = try #require(model.rows.first { $0.id == "18" })

    await model.select(row)

    #expect(api.sent.last == .post("read-notification", ["id": "18"]))
    #expect(shell.router.sheet == nil)
    #expect(shell.router[stack: .circle] == [.title(id: "tv:201", item: entry, reply: "3")])
    // The screen beneath reads again, which updates the bell's count.
    #expect(shell.liveRefreshes == refreshes + 1)
    #expect(model.failure == nil)
    #expect(model.activity == .idle)
  }

  @Test func marksAllReadThroughTheNewestShownNotification() async throws {
    let api = try NotificationsAPI()
    let (model, shell) = sheet(api)
    await model.live.refresh()
    let refreshes = shell.liveRefreshes

    await model.markAllRead()

    #expect(
      api.sent == [
        .get("notifications"), .post("read-notifications", ["through": "23"]),
        .get("notifications"),
      ]
    )
    #expect(shell.liveRefreshes == refreshes + 1)
    #expect(shell.router.sheet == .notifications)
  }

  @Test func earlierPagesKeepTheNewestPagesBoundary() async throws {
    let api = try NotificationsAPI()
    let (model, _) = sheet(api)
    api.pages = [try NotificationsAPI.page(ids: ["40", "39"], through: "40", next: "39")]
    await model.live.refresh()
    #expect(model.page == .latest)

    model.showEarlier()
    #expect(model.page == .earlier(before: "39", through: "40"))
    api.pages = [try NotificationsAPI.page(ids: ["12"], through: "40", unread: 3)]
    await model.live.refresh()
    await model.markAllRead()
    model.showLatest()

    #expect(model.page == .latest)
    #expect(
      api.sent == [
        .get("notifications"), .get("notifications", ["before": "39", "through": "40"]),
        .post("read-notifications", ["through": "40"]),
        .get("notifications", ["before": "39", "through": "40"]),
      ]
    )
  }

  @Test func answersAFriendRequestInPlaceUntilTheViewChanges() async throws {
    let api = try NotificationsAPI()
    let (model, shell) = sheet(api)
    await model.live.refresh()
    let request = try #require(model.rows.first { $0.id == "14" })
    let refreshes = shell.liveRefreshes
    // Once answered, the server stops listing the request.
    api.pages = [try NotificationsAPI.page(ids: ["23", "20", "18", "5", "3", "1"], through: "23")]

    await model.respond(to: request.item, .accept)

    #expect(
      Array(api.sent.dropFirst()) == [
        .post("respond-friend-request", ["id": "14", "action": "accept"]), .get("notifications"),
      ]
    )
    #expect(shell.liveRefreshes == refreshes + 1)
    let answered = try #require(model.rows.first { $0.id == "14" })
    #expect(answered.answer == .accept)
    #expect(!answered.isUnread)
    #expect(!answered.offersAnswer)
    #expect(model.rows.map(\.id) == ["23", "20", "18", "14", "5", "3", "1"])

    // An answered request is already read, so selecting it only opens it.
    await model.select(answered)
    #expect(api.sent.last == .get("notifications"))
    #expect(shell.router[stack: .circle] == [.profile(username: "fay")])

    model.show(.unread)
    await model.live.refresh()
    #expect(model.rows.first { $0.id == "14" } == nil)
  }

  @Test func confirmsADeclineFirst() async throws {
    let api = try NotificationsAPI()
    let (model, _) = sheet(api)
    await model.live.refresh()
    let request = try #require(model.rows.first { $0.id == "14" })

    model.askToDecline(request.item)
    #expect(model.declining == request.item)
    model.cancelDecline()
    #expect(model.declining == nil)
    #expect(api.sent == [.get("notifications")])

    model.askToDecline(request.item)
    await model.respond(to: request.item, .decline)

    #expect(model.declining == nil)
    #expect(api.sent.contains(.post("respond-friend-request", ["id": "14", "action": "decline"])))
    #expect(model.rows.first { $0.id == "14" }?.answer == .decline)
  }

  @Test func reportsAFailedActionAndReadsAgain() async throws {
    let api = try NotificationsAPI()
    let (model, shell) = sheet(api)
    await model.live.refresh()
    let row = try #require(model.rows.first { $0.id == "18" })
    api.failures["read-notification"] = APIError(
      kind: .notFound,
      message: "Notification is no longer available.",
      requestID: "request-1"
    )

    await model.select(row)

    #expect(model.failure?.action == .select)
    #expect(model.failure?.error.explanation == "Notification is no longer available.")
    #expect(
      api.sent.suffix(2) == [.post("read-notification", ["id": "18"]), .get("notifications")]
    )
    #expect(shell.router.sheet == .notifications)
    #expect(shell.router[stack: .circle].isEmpty)
    #expect(model.activity == .idle)

    model.dismissFailure()
    #expect(model.failure == nil)
  }

  @Test func waitsForAnActionBeforeTheNext() async throws {
    let api = try NotificationsAPI()
    let (model, _) = sheet(api)
    await model.live.refresh()
    let row = try #require(model.rows.first { $0.id == "18" })
    api.hanging = "read-notification"

    let selecting = Task { await model.select(row) }
    await api.waitForRequests(2)
    #expect(model.activity == .sending)
    #expect(!model.canMarkAllRead)
    await model.markAllRead()
    model.show(.unread)

    #expect(model.filter == .all)
    #expect(api.sent == [.get("notifications"), .post("read-notification", ["id": "18"])])
    selecting.cancel()
    await selecting.value
  }
}

// The real client against the fixture API, recording what the sheet sends.
// A test can script the notification pages, fail an action, or hold one.
private final class NotificationsAPI: ScreenrAPI {
  struct Sent: Hashable, Sendable, CustomStringConvertible {
    let method: HTTPMethod
    let action: String
    let fields: [String: String]

    static func get(_ action: String, _ query: [String: String] = [:]) -> Sent {
      Sent(method: .get, action: action, fields: query)
    }

    static func post(_ action: String, _ body: [String: String]) -> Sent {
      Sent(method: .post, action: action, fields: body)
    }

    var description: String { "\(method.rawValue) \(action) \(fields)" }
  }

  private struct State {
    var sent: [Sent] = []
    var pages: [NotificationPage] = []
    var failures: [String: APIError] = [:]
    var hanging: String?
    var watchers: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  private let client: ScreenrClient
  private let state = Mutex(State())

  @MainActor
  init() throws {
    let session = try SessionStore(keychain: InMemoryKeychain(token: FixtureTransport.token))
    client = ScreenrClient(
      serverURL: try #require(URL(string: "http://localhost:3000")),
      clientHeader: "ios/1.0/7",
      session: session,
      transport: try FixtureTransport(directory: TestFixtures.directory)
    )
  }

  var sent: [Sent] { state.withLock { $0.sent } }

  // Pages that answer `notifications` in turn, the last one repeating, in
  // place of the fixtures.
  var pages: [NotificationPage] {
    get { state.withLock { $0.pages } }
    set { state.withLock { $0.pages = newValue } }
  }

  var failures: [String: APIError] {
    get { state.withLock { $0.failures } }
    set { state.withLock { $0.failures = newValue } }
  }

  // An action whose requests wait until they are cancelled.
  var hanging: String? {
    get { state.withLock { $0.hanging } }
    set { state.withLock { $0.hanging = newValue } }
  }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    let action = request.endpoint.path.replacing("/api/screenr/", with: "")
    let (page, failure, hangs, woken) = state.withLock { state in
      state.sent.append(Sent(method: request.method, action: action, fields: Self.fields(request)))
      let page =
        action == "notifications" && !state.pages.isEmpty
        ? (state.pages.count > 1 ? state.pages.removeFirst() : state.pages[0]) : nil
      let count = state.sent.count
      let woken = state.watchers.filter { $0.count <= count }.map(\.continuation)
      state.watchers.removeAll { $0.count <= count }
      return (page, state.failures[action], state.hanging == action, woken)
    }
    for watcher in woken { watcher.resume() }
    if let failure { throw failure }
    if hangs {
      let stream = AsyncStream<Never> { _ in }
      for await _ in stream {}
      throw APIError(kind: .cancelled, requestID: "hanging")
    }
    if let page {
      guard let response = page as? Response else {
        throw APIError(kind: .invalidResponse, requestID: "scripted")
      }
      return response
    }
    return try await client.send(request)
  }

  // Waits until the API has received `count` requests.
  func waitForRequests(_ count: Int) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let waiting = state.withLock { state in
        guard state.sent.count < count else { return false }
        state.watchers.append((count, continuation))
        return true
      }
      if !waiting { continuation.resume() }
    }
  }

  private static func fields<Response>(_ request: APIRequest<Response>) -> [String: String] {
    guard case .json(.object(let body)) = request.body else { return request.query }
    return body.compactMapValues { value in
      guard case .string(let text) = value else { return nil }
      return text
    }
  }

  // A page of friend acceptances with these IDs, newest first.
  static func page(
    ids: [String],
    through: String,
    unread: Int = 1,
    next: String? = nil
  ) throws -> NotificationPage {
    let items: [JSONValue] = ids.map { id in
      [
        "id": .string(id), "kind": "friend_accepted", "actor": "Cam Rivera", "actorId": "user-cam",
        "actorPhoto": .null, "message": "Cam Rivera became your friend.", "href": "/people/cam",
        "createdAt": "2026-10-13T12:00:00.000Z", "read": false,
      ]
    }
    let following: JSONValue =
      if let next { .string(next) } else { .null }
    let body: JSONValue = [
      "items": .array(items), "through": .string(through), "unread": .integer(unread),
      "next": following,
    ]
    return try ScreenrJSON.decoder()
      .decode(
        NotificationPage.self,
        from: try JSONEncoder().encode(body)
      )
  }
}
