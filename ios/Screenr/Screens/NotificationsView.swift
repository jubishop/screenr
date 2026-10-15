import ScreenrKit
import SwiftUI

// The bell's notifications, in a sheet over the current screen: All or
// Unread, a page at a time, kept current while the sheet shows. Selecting one
// closes the sheet and opens its item; closing the sheet any other way leaves
// the screen beneath as it was.
struct NotificationsView: View {
  @Environment(ShellModel.self) private var shell

  var body: some View {
    NotificationsList(shell: shell)
  }
}

private struct NotificationsList: View {
  @State private var model: NotificationsModel

  init(shell: ShellModel) {
    _model = State(initialValue: NotificationsModel(shell: shell))
  }

  var body: some View {
    VStack(spacing: 0) {
      NotificationControls(model: model)
        .padding(.horizontal)
        .padding(.vertical, 8)
      NotificationsContent(model: model)
        .livePolling(model.live)
        // Each view of the list has its own read, which polls while it shows.
        .id(ObjectIdentifier(model.live))
    }
    .alert(
      failureTitle,
      isPresented: Binding(get: { failure != nil }, set: { if !$0 { model.dismissFailure() } }),
      presenting: failure
    ) { _ in
      Button("OK", role: .cancel) { model.dismissFailure() }
    } message: { failure in
      Text(failure.error.explanation)
    }
  }

  // Read while rendering, so a new failure renders the alert.
  private var failure: NotificationsModel.Failure? { model.failure }

  private var failureTitle: String {
    switch failure?.action {
    case .select, nil: "Couldn’t open the notification"
    case .respond(.accept): "Couldn’t accept the request"
    case .respond(.decline): "Couldn’t decline the request"
    case .markAllRead: "Couldn’t mark all as read"
    }
  }
}

// All or Unread, and Mark all as read.
private struct NotificationControls: View {
  let model: NotificationsModel

  var body: some View {
    HStack(spacing: 16) {
      filter.fixedSize()
      Spacer(minLength: 0)
      markAll
        .multilineTextAlignment(.trailing)
    }
  }

  private var filter: some View {
    Picker("Show", selection: Binding(get: { model.filter }, set: { model.show($0) })) {
      Text("All").tag(NotificationFilter.all)
      Text("Unread").tag(NotificationFilter.unread)
    }
    .pickerStyle(.segmented)
    .disabled(model.activity == .sending)
  }

  private var markAll: some View {
    Button("Mark all as read") {
      Task { await model.markAllRead() }
    }
    .disabled(!model.canMarkAllRead)
  }
}

// The sheet's read: a spinner, the failure with Try again, or the list.
private struct NotificationsContent: View {
  let model: NotificationsModel

  var body: some View {
    switch model.live.phase {
    case .loading:
      ProgressView("Loading notifications")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let error):
      ReadFailureView(error: error) {
        await model.live.refresh()
      }
    case .loaded:
      List {
        if model.rows.isEmpty {
          EmptyNotifications(filter: model.filter, page: model.page)
            .listRowSeparator(.hidden)
        } else {
          ForEach(model.rows) { row in
            NotificationRow(row: row, model: model)
          }
        }
        if model.page != .latest || model.hasEarlier {
          Section {
            if model.page != .latest {
              Button("Latest notifications") { model.showLatest() }
            }
            if model.hasEarlier {
              Button("Earlier notifications") { model.showEarlier() }
            }
          }
          .disabled(model.activity == .sending)
        }
      }
      .listStyle(.plain)
    }
  }
}

// One notification: what happened and when, marked while unread. A pending
// friend request also offers Accept and Decline, and an answered one shows
// its result in their place.
private struct NotificationRow: View {
  let row: NotificationsModel.Row
  let model: NotificationsModel
  @ScaledMetric(relativeTo: .body) private var dot = 10.0

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        Task { await model.select(row) }
      } label: {
        summary
      }
      .buttonStyle(.plain)
      .accessibilityValue(row.isUnread ? "Unread" : "")
      .accessibilityHint(row.item.kind.hint)
      if let answer = row.answer {
        Text(answer.result)
          .font(.subheadline)
      } else if row.offersAnswer {
        responses
      }
    }
    .padding(.vertical, 4)
    .disabled(model.activity == .sending)
  }

  private var summary: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: row.item.kind.symbol)
        .font(.title3)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(row.item.message)
          .fontWeight(row.isUnread ? .semibold : .regular)
          .multilineTextAlignment(.leading)
        // A shown time follows the clock, as the web's do.
        TimelineView(.everyMinute) { _ in
          Text(row.item.createdAt.formatted(.relative(presentation: .named)))
        }
        .font(.subheadline)
        .foregroundStyle(.muted)
      }
      Spacer(minLength: 0)
      if row.isUnread {
        Circle()
          .fill(.tint)
          .frame(width: dot, height: dot)
          .padding(.top, 6)
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
  }

  private var responses: some View {
    // Read while rendering, so asking to decline presents the confirmation.
    let declining = model.declining?.id == row.id
    return HStack(spacing: 12) {
      Button("Accept") {
        Task {
          await model.respond(to: row.item, .accept)
          announce()
        }
      }
      .buttonStyle(.accent)
      Button("Decline") { model.askToDecline(row.item) }
        .buttonStyle(.bordered)
        .confirmationDialog(
          "Decline \(row.item.actor)’s friend request?",
          isPresented: Binding(get: { declining }, set: { if !$0 { model.cancelDecline() } }),
          titleVisibility: .visible
        ) {
          Button("Decline", role: .destructive) {
            Task {
              await model.respond(to: row.item, .decline)
              announce()
            }
          }
          Button("Cancel", role: .cancel) { model.cancelDecline() }
        } message: {
          Text("The request will be removed.")
        }
    }
  }

  // VoiceOver hears the result that replaces the buttons.
  private func announce() {
    guard let answer = model.rows.first(where: { $0.id == row.id })?.answer else { return }
    AccessibilityNotification.Announcement(answer.result).post()
  }
}

// An empty list, in the web's words.
private struct EmptyNotifications: View {
  let filter: NotificationFilter
  let page: NotificationsModel.Page

  var body: some View {
    switch (filter, page) {
    case (.unread, _):
      ContentUnavailableView(
        "You’re all caught up.",
        systemImage: "checkmark.circle",
        description: Text("New notifications will appear here.")
      )
    case (.all, .earlier):
      ContentUnavailableView(
        "No earlier notifications.",
        systemImage: "bell",
        description: Text(Self.kinds)
      )
    case (.all, .latest):
      ContentUnavailableView(
        "No notifications yet.",
        systemImage: "bell",
        description: Text(Self.kinds)
      )
    }
  }

  private static let kinds =
    "Friend requests, new friendships, comments, and replies will appear here."
}

extension NotificationKind {
  fileprivate var symbol: String {
    switch self {
    case .friendRequest: "person.badge.plus"
    case .friendAccepted: "person.2"
    case .comment: "bubble.left"
    case .reply: "arrowshape.turn.up.left"
    case .unknown: "bell"
    }
  }

  fileprivate var hint: String {
    switch self {
    case .friendRequest, .friendAccepted: "Opens their profile."
    case .comment, .reply, .unknown: "Opens the comment."
    }
  }
}

extension FriendRequestResponse {
  fileprivate var result: String {
    switch self {
    case .accept: "Friend request accepted."
    case .decline: "Friend request declined."
    }
  }
}
