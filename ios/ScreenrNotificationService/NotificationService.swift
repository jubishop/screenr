import Foundation
import ScreenrKit
import Synchronization
import UserNotifications

// The Notification Service Extension's entry point. iOS runs it for each
// alert the worker marks mutable, before showing the alert. It reads the
// push's notification with the app's Keychain session and shows it as a
// Communication Notification from its sender, or keeps the payload's generic
// alert. It logs to its own `notifications` file in the app group, which the
// app's feedback form attaches, and starts no Sentry.
final class NotificationService: UNNotificationServiceExtension {
  // The push in progress. iOS calls this object from threads of its own.
  private let current = Mutex<PushContentLoader?>(nil)

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let delivery = Delivery(content: request.content, handler: contentHandler)
    let loader = PushContentLoader { alert in delivery.send(alert) }
    current.withLock { $0 = loader }
    let tap = PushTap(userInfo: request.content.userInfo)
    Task { @MainActor in
      let log = NotificationExtension.logFile
      do {
        try await NotificationExtension.services.run(
          arguments: NotificationExtension.arguments()
        ) { services in
          await loader.load(
            tap,
            api: services.api,
            avatars: .network(images: services.images, session: services.imageSession)
          )
        }
      } catch {
        loader.unavailable(error)
      }
      await log?.flush()
    }
  }

  override func serviceExtensionTimeWillExpire() {
    current.withLock { $0 }?.timeWillExpire()
  }
}

// iOS's handler for one push, and the content the push arrived with. iOS
// accepts the handler's call from any thread, and the content never changes,
// so the delivery crosses threads; its loader calls it once.
private final class Delivery: @unchecked Sendable {
  private let content: UNNotificationContent
  private let handler: (UNNotificationContent) -> Void

  init(content: UNNotificationContent, handler: @escaping (UNNotificationContent) -> Void) {
    self.content = content
    self.handler = handler
  }

  func send(_ alert: PushAlert) {
    switch alert {
    case .rich(let push, let avatar):
      handler(push.notificationContent(updating: content, avatar: avatar))
    case .generic:
      handler(content)
    }
  }
}

// What every push in this process shares. iOS may show several pushes in one
// process.
@MainActor
private enum NotificationExtension {
  static let configuration: AppConfiguration = {
    do {
      return try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The extension's Screenr settings are invalid: \(error)")
    }
  }()

  // The log, which starts with the process's first push.
  static let logFile: LogFile? = {
    guard let directory = LogFile.directory(appGroup: configuration.appGroup) else { return nil }
    let file = LogFile(directory: directory, name: "notifications")
    LogRouter.shared.add(file)
    return file
  }()

  static let telemetry = Telemetry.localOnly()

  // The client and image connections, which pushes share while the member's
  // session stays the same, since the member may sign in again between them.
  static let services = ExtensionServices { arguments in
    try AppServices(
      configuration: configuration,
      arguments: arguments,
      observer: telemetry,
      host: .notificationExtension
    )
  }

  // Screenr Dev's extension answers from the fixtures the app last launched
  // with, as Simulator checks need.
  static func arguments() -> [String] {
    let arguments = ProcessInfo.processInfo.arguments
    return FixtureHandoff(configuration: configuration)?.arguments(arguments) ?? arguments
  }
}
