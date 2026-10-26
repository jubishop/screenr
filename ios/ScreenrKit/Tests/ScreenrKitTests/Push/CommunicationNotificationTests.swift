#if os(iOS)
import Foundation
import Intents
import Testing
import UserNotifications

@testable import ScreenrKit

// A rich alert as iOS's Communication Notification: an incoming message
// from the notification's sender, with their photo as its avatar. These run
// only in the Simulator, since the message intent is iOS's.
struct CommunicationNotificationTests {
  @Test func theMessageComesFromTheSender() throws {
    let content = PushContent(try pushNotification("comment"))

    let intent = content.messageIntent(avatar: Data("jpeg".utf8))

    let sender = try #require(intent.sender)
    #expect(sender.displayName == "Ben Ortiz")
    #expect(sender.personHandle?.value == "user-ben")
    #expect(sender.customIdentifier == "user-ben")
    #expect(sender.image != nil)
    #expect(intent.recipients == nil)
    #expect(intent.speakableGroupName == nil)
    #expect(intent.content == "Commented on your post about Harbor Lights: Wait until season 2.")
    #expect(intent.conversationIdentifier == "e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
  }

  @Test func aSenderWithoutAPhotoHasNoAvatar() throws {
    let content = PushContent(try pushNotification("friend-request"))

    let intent = content.messageIntent(avatar: nil)

    #expect(intent.sender?.image == nil)
    #expect(intent.content == "Sent you a friend request.")
    #expect(intent.conversationIdentifier == "user-fay")
  }

  // A spoiler's message, which Siri may read aloud, holds no comment text.
  @Test func aSpoilersMessageHidesItsText() throws {
    let content = PushContent(try pushNotification("spoiler"))

    #expect(
      content.messageIntent(avatar: nil).content
        == "Replied to your comment about Harbor Lights. Contains spoilers."
    )
  }

  // The payload's notification ID, category, and thread stay, so a tap
  // still opens the notification and its replies still group.
  @Test func theAlertKeepsThePayloadsRouting() throws {
    let original = UNMutableNotificationContent()
    original.body = "New activity on Screenr"
    original.categoryIdentifier = "COMMENT"
    original.threadIdentifier = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
    original.userInfo = ["notificationId": "18"]

    let alert = PushContent(try pushNotification("comment"))
      .notificationContent(updating: original, avatar: nil)

    #expect(alert.title == "Ben Ortiz")
    #expect(alert.body == "Commented on your post about Harbor Lights: Wait until season 2.")
    #expect(alert.categoryIdentifier == "COMMENT")
    #expect(alert.threadIdentifier == "e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
    #expect(PushTap(userInfo: alert.userInfo).notificationID == "18")
  }
}
#endif
