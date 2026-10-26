#if os(iOS)
import Foundation
import Intents
import UserNotifications

// A rich alert as iOS's Communication Notification. Its message intent is
// iOS's alone, so this builds only for iOS.
extension PushContent {
  // The payload's content, which keeps its notification ID, category, and
  // thread, with this alert's text, as an incoming message from the sender
  // with their photo as its avatar. The message is donated to Siri, which
  // learns whose messages matter to the member. If iOS cannot make it a
  // Communication Notification, the alert still shows its text.
  public func notificationContent(
    updating original: UNNotificationContent,
    avatar: Data?
  ) -> UNNotificationContent {
    guard let content = original.mutableCopy() as? UNMutableNotificationContent else {
      return original
    }
    content.title = sender.name
    content.body = body
    let intent = messageIntent(avatar: avatar)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.donate { error in
      guard let error else { return }
      Log.push.info("Donating a push's message failed", .error(error))
    }
    do {
      return try content.updating(from: intent)
    } catch {
      Log.push.warning("A push could not become a Communication Notification", .error(error))
      return content
    }
  }

  // One sender's message to the member alone, in the conversation that
  // groups its alerts.
  func messageIntent(avatar: Data?) -> INSendMessageIntent {
    var image: INImage?
    if let avatar { image = INImage(imageData: avatar) }
    let person = INPerson(
      personHandle: INPersonHandle(value: sender.id, type: .unknown),
      nameComponents: nil,
      displayName: sender.name,
      image: image,
      contactIdentifier: nil,
      customIdentifier: sender.id
    )
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: body,
      speakableGroupName: nil,
      conversationIdentifier: conversation,
      serviceName: nil,
      sender: person,
      attachments: nil
    )
    if let image { intent.setImage(image, forParameterNamed: \.sender) }
    return intent
  }
}
#endif
