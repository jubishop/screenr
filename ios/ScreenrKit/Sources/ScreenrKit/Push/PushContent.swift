import Foundation

// What a push's alert shows once the notification extension has read its
// notification: who sent it, the action, and the comment's excerpt, which the
// payload's generic alert leaves out. iOS shows it as a Communication
// Notification: a direct message from the sender, with their name in place of
// a title and subtitle and their photo as its avatar. So the body leads with
// the action, such as "Replied to your comment about Harbor Lights: …".
public struct PushContent: Hashable, Sendable {
  public let sender: PushSender
  public let body: String
  // Groups one conversation's alerts: a comment's entry, the APNs thread, or
  // for a friendship, its sender.
  public let conversation: String

  public init(_ notification: PushNotification) {
    let item = notification.item
    sender = PushSender(id: item.actorId, name: item.actor, photo: item.actorPhoto)
    conversation = notification.thread ?? item.actorId
    var about = ""
    if let title = notification.title { about = " about \(title)" }
    let comment: String
    switch item.kind {
    case .friendRequest:
      body = "Sent you a friend request."
      return
    case .friendAccepted:
      body = "Became your friend."
      return
    // A kind this build does not know shows the bell's sentence for it.
    case .unknown:
      body = item.message
      return
    case .comment: comment = "Commented on your post" + about
    case .reply: comment = "Replied to your comment" + about
    }
    // The server leaves a spoiler's text out; the alert never shows one.
    if notification.spoiler {
      body = comment + ". Contains spoilers."
    } else if let excerpt = notification.excerpt {
      body = comment + ": " + excerpt
    } else {
      body = comment + "."
    }
  }
}

// The member a push is from.
public struct PushSender: Hashable, Sendable {
  // Their Screenr user ID.
  public let id: String
  public let name: String
  // Their profile photo's version, for `/api/photos/<id>/<photo>`, or nil
  // without one.
  public let photo: String?

  public init(id: String, name: String, photo: String?) {
    self.id = id
    self.name = name
    self.photo = photo
  }
}
