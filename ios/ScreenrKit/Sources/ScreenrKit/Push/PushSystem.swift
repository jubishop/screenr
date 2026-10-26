import Foundation
import UserNotifications

// Whether the member lets Screenr notify them on this iPhone, as iOS reports it.
public enum PushPermission: Hashable, Sendable {
  // Not read yet.
  case unknown
  // iOS has not asked the member yet.
  case undecided
  case denied
  // Alerts, or iOS's quiet provisional delivery.
  case allowed
}

// iOS's side of push notifications: the permission, APNs registration, the
// app icon's badge, and Notification Center. The app's implementation wraps
// `UNUserNotificationCenter` and `UIApplication`; tests and fixture launches
// use fakes.
@MainActor
public protocol PushSystem: AnyObject, Sendable {
  func permission() async -> PushPermission
  // Shows iOS's permission prompt and returns the member's answer.
  func requestPermission() async throws -> PushPermission
  // Asks APNs for the device token, which iOS hands to the app delegate for
  // `PushNotifications.received(token:)`.
  func registerForRemoteNotifications()
  func setBadgeCount(_ count: Int) async throws
  // Clears the notifications Notification Center still shows.
  func removeDeliveredNotifications()
}

// Where APNs reaches this build: the device token's environment, the bundle
// ID that APNs requests name as their topic, and the build number.
public struct PushTarget: Hashable, Sendable {
  public let environment: PushEnvironment
  public let topic: String
  public let build: Int

  public init(environment: PushEnvironment, topic: String, build: Int) {
    self.environment = environment
    self.topic = topic
    self.build = build
  }
}

// The categories the worker names in its alerts. The app registers them at
// launch, with the actions each offers.
public enum PushCategory: String, CaseIterable, Sendable {
  // `friend_request`.
  case friendRequest = "FRIEND_REQUEST"
  // `comment` and `reply`.
  case comment = "COMMENT"

  public static var notificationCategories: Set<UNNotificationCategory> {
    Set(allCases.map(\.notificationCategory))
  }

  public var actions: [PushAction.Identifier] {
    switch self {
    case .friendRequest: [.accept, .decline]
    case .comment: [.reply]
    }
  }

  public var notificationCategory: UNNotificationCategory {
    UNNotificationCategory(
      identifier: rawValue,
      actions: actions.map(\.notificationAction),
      intentIdentifiers: [],
      options: []
    )
  }
}

// An action the member chose on a notification instead of tapping it, which
// the app performs in the background without opening.
public enum PushAction: Hashable, Sendable {
  case respond(FriendRequestResponse)
  // The text the member typed.
  case reply(String)

  // The actions the categories offer. Each changes what others see, so a
  // locked iPhone asks for the passcode or Face ID first.
  public enum Identifier: String, CaseIterable, Sendable {
    case accept = "ACCEPT"
    case decline = "DECLINE"
    case reply = "REPLY"

    public var notificationAction: UNNotificationAction {
      switch self {
      case .accept:
        UNNotificationAction(
          identifier: rawValue,
          title: "Accept",
          options: [.authenticationRequired],
          icon: UNNotificationActionIcon(systemImageName: "checkmark")
        )
      case .decline:
        UNNotificationAction(
          identifier: rawValue,
          title: "Decline",
          options: [.authenticationRequired, .destructive],
          icon: UNNotificationActionIcon(systemImageName: "xmark")
        )
      case .reply:
        UNTextInputNotificationAction(
          identifier: rawValue,
          title: "Reply",
          options: [.authenticationRequired],
          icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
          textInputButtonTitle: "Post",
          textInputPlaceholder: "What do you think?"
        )
      }
    }
  }

  // The action behind a response's identifier, with the text a Reply sent.
  // Nil for a tap, a dismissal, or an identifier this build does not offer.
  public init?(identifier: String, text: String?) {
    switch Identifier(rawValue: identifier) {
    case .accept: self = .respond(.accept)
    case .decline: self = .respond(.decline)
    case .reply: self = .reply(text ?? "")
    case nil: return nil
    }
  }

  public var identifier: Identifier {
    switch self {
    case .respond(.accept): .accept
    case .respond(.decline): .decline
    case .reply: .reply
    }
  }
}
