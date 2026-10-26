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
      // A new session for each push, since the member may have signed in
      // again since the last one this process showed.
      let services: AppServices
      do {
        services = try NotificationExtension.services()
      } catch {
        loader.unavailable(error)
        await log?.flush()
        return
      }
      await loader.load(
        tap,
        api: services.api,
        avatars: .network(images: services.images, session: services.imageSession)
      )
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

  // Screenr Dev's extension answers from the fixtures the app last launched
  // with, as Simulator checks need.
  static func services() throws -> AppServices {
    let arguments = ProcessInfo.processInfo.arguments
    return try AppServices(
      configuration: configuration,
      arguments: FixtureHandoff(configuration: configuration)?.arguments(arguments) ?? arguments,
      observer: telemetry,
      host: .notificationExtension
    )
  }
}
