import Foundation
import Observation

// The bell's sheet, as the web's notification panel behaves:
//
// - It shows one page of up to 30 notifications, all or only unread ones,
//   and polls it while the sheet shows. Opening it marks nothing read.
// - Selecting a notification marks it read, closes the sheet, and opens its
//   person or exact reply.
// - Mark all as read stops at the newest notification in the shown page, so
//   later arrivals stay unread. Earlier pages keep that boundary.
// - A pending friend request offers Accept and Decline, and Decline asks
//   first. The answered request keeps its result in place of the buttons
//   until the view changes, although the server no longer lists it.
// - One action runs at a time. A failed one is reported, and the page reads
//   again.
@MainActor
@Observable
public final class NotificationsModel {
  // The newest page, or an earlier one that keeps the newest's Mark all as
  // read boundary.
  public enum Page: Hashable, Sendable {
    case latest
    case earlier(before: String, through: String)
  }

  public enum Activity: Hashable, Sendable {
    case idle
    // An action is waiting for the server; the sheet's controls wait too.
    case sending
  }

  public enum Action: Hashable, Sendable {
    case select
    case respond(FriendRequestResponse)
    case markAllRead
  }

  public struct Failure: Hashable, Sendable {
    public let action: Action
    public let error: APIError
  }

  // A notification as the sheet lists it.
  public struct Row: Hashable, Sendable, Identifiable {
    public let item: NotificationItem
    // How the member answered this friend request while the view showed.
    public let answer: FriendRequestResponse?

    public var id: String { item.id }
    // Answering a request also reads it.
    public var isUnread: Bool { answer == nil && !item.read }
    public var offersAnswer: Bool { answer == nil && item.kind == .friendRequest }
  }

  public private(set) var filter = NotificationFilter.all
  public private(set) var page = Page.latest
  // The shown page's read. Changing the view replaces it, so a view that
  // polls it should take its identity.
  public private(set) var live: LiveRead<NotificationPage>
  public private(set) var activity = Activity.idle
  // The friend request whose Decline waits for confirmation.
  public private(set) var declining: NotificationItem?
  public private(set) var failure: Failure?
  private var answered: [String: Row] = [:]

  @ObservationIgnored private let shell: ShellModel
  @ObservationIgnored private let clock: any Clock<Duration>

  // The sheet reads through the shell's API, sets the bell's count from each
  // page, and opens notifications with the shell's router.
  public init(shell: ShellModel, clock: any Clock<Duration> = ContinuousClock()) {
    self.shell = shell
    self.clock = clock
    live = Self.read(.notifications(), shell: shell, clock: clock)
  }

  // The shown page's notifications, with requests answered in this view,
  // newest first.
  public var rows: [Row] {
    guard let value = live.value else { return [] }
    let listed = Set(value.items.map(\.id))
    let rows =
      value.items.map { item in Row(item: item, answer: answered[item.id]?.answer) }
      + answered.values.filter { !listed.contains($0.id) }
    return rows.sorted { Self.isNewer($0.id, than: $1.id) }
  }

  public var canMarkAllRead: Bool {
    activity == .idle && (live.value?.unread ?? 0) > 0
  }

  // Whether an earlier page follows the shown one.
  public var hasEarlier: Bool {
    live.value?.next != nil
  }

  public func show(_ filter: NotificationFilter) {
    guard activity == .idle, filter != self.filter || page != .latest else { return }
    self.filter = filter
    change(to: .latest)
  }

  public func showEarlier() {
    guard activity == .idle, let value = live.value, let next = value.next,
      let through = value.through
    else { return }
    change(to: .earlier(before: next, through: through))
  }

  public func showLatest() {
    guard activity == .idle, page != .latest else { return }
    change(to: .latest)
  }

  // Marks the notification read and opens its item, which closes the sheet.
  // An answered request is already read, so it only opens.
  public func select(_ row: Row) async {
    guard activity == .idle else { return }
    guard row.answer == nil else {
      shell.router.open(Destination(path: row.item.href))
      return
    }
    await send(.select) { () async throws(APIError) in
      let target = try await shell.api.send(.readNotification(id: row.item.id))
      shell.refreshLiveReads()
      shell.router.open(Destination(path: target.href))
    }
  }

  public func respond(to item: NotificationItem, _ response: FriendRequestResponse) async {
    guard activity == .idle else { return }
    declining = nil
    await send(.respond(response)) { () async throws(APIError) in
      _ = try await shell.api.send(.respondToFriendRequest(notification: item.id, response))
      answered[item.id] = Row(item: item, answer: response)
      shell.refreshLiveReads()
      await live.refresh()
    }
  }

  public func askToDecline(_ item: NotificationItem) {
    guard activity == .idle else { return }
    declining = item
  }

  public func cancelDecline() {
    declining = nil
  }

  // Marks every notification read through the newest in the shown page, or
  // the boundary an earlier page keeps.
  public func markAllRead() async {
    guard canMarkAllRead, let through = live.value?.through else { return }
    await send(.markAllRead) { () async throws(APIError) in
      _ = try await shell.api.send(.readNotifications(through: through))
      shell.refreshLiveReads()
      await live.refresh()
    }
  }

  public func dismissFailure() {
    failure = nil
  }

  private func send(_ action: Action, _ work: () async throws(APIError) -> Void) async {
    activity = .sending
    defer { activity = .idle }
    do throws(APIError) {
      try await work()
    } catch  where error.kind == .cancelled {
      return
    } catch {
      failure = Failure(action: action, error: error)
      await live.refresh()
    }
  }

  private func change(to page: Page) {
    self.page = page
    answered = [:]
    declining = nil
    live.disappeared()
    let request: APIRequest<NotificationPage> =
      switch page {
      case .latest: .notifications(filter: filter)
      case .earlier(let before, let through):
        .notifications(before: before, through: through, filter: filter)
      }
    live = Self.read(request, shell: shell, clock: clock)
  }

  private static func read(
    _ request: APIRequest<NotificationPage>,
    shell: ShellModel,
    clock: any Clock<Duration>
  ) -> LiveRead<NotificationPage> {
    LiveRead(request, api: shell.api, clock: clock) { [weak shell] page in
      shell?.setUnreadNotifications(page.unread)
    }
  }

  // Notification IDs are decimal numbers without leading zeros.
  private static func isNewer(_ id: String, than other: String) -> Bool {
    id.count == other.count ? id > other : id.count > other.count
  }
}
