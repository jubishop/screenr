import Foundation
import UserNotifications

// The alert the app posts in place of a notification action that failed, so
// the member learns it did not happen: "Your reply wasn’t posted", with why.
// Tapping it opens the notification as tapping the original does, and a
// reply's text waits as the draft of its composer there.
public struct FailedActionAlert: Hashable, Sendable {
  public let notificationID: String
  public let action: PushAction
  public let body: String

  public init(notificationID: String, action: PushAction, error: APIError) {
    self.init(notificationID: notificationID, action: action, body: error.explanation)
  }

  init(notificationID: String, action: PushAction, body: String) {
    self.notificationID = notificationID
    self.action = action
    self.body = body
  }

  public var title: String {
    switch action {
    case .respond(.accept): "The friend request wasn’t accepted"
    case .respond(.decline): "The friend request wasn’t declined"
    case .reply: "Your reply wasn’t posted"
    }
  }

  // One alert per notification, which a later failure replaces.
  public var identifier: String { "failed-action-\(notificationID)" }

  // The alert, with no actions of its own. Its payload names the
  // notification, as a push's does, and a reply's text for `PushTap`.
  public var content: UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    var userInfo: [String: String] = [PushTap.notificationKey: notificationID]
    if case .reply(let text) = action { userInfo[PushTap.unpostedReplyKey] = text }
    content.userInfo = userInfo
    return content
  }
}
