import Foundation
import Synchronization

// The alert the notification extension shows for a push.
public enum PushAlert: Hashable, Sendable {
  // A Communication Notification from the notification's sender, with their
  // photo when it loaded in time.
  case rich(PushContent, avatar: Data?)
  // The payload's own "New activity on Screenr", and why it stays.
  case generic(PushFallback)
}

// Why a push keeps its generic alert.
public enum PushFallback: String, CaseIterable, Hashable, Sendable {
  // The payload names no notification.
  case missingID = "missing_id"
  // The member can no longer see the notification, such as after blocking
  // its sender or losing access to its entry.
  case hidden
  // The read failed, or the extension could not reach the session, such as
  // while the Keychain is locked after a restart.
  case failed
  // iOS's time for the extension ran out before the read finished.
  case timedOut = "timed_out"
}

// Builds one push's alert in the notification extension. It reads the push's
// notification, which applies the bell's access rules as the alert shows,
// then the sender's photo for the avatar. It delivers exactly once: the alert
// when it is ready, or when iOS's time runs out first, the best one so far,
// which is the rich alert without its avatar once the read has finished.
// iOS may call it from any thread.
public final class PushContentLoader: Sendable {
  private enum Progress: Sendable {
    case reading
    case loadingAvatar(PushContent)
    case delivered
  }

  private let progress = Mutex(Progress.reading)
  private let deliver: @Sendable (PushAlert) -> Void

  public init(deliver: @escaping @Sendable (PushAlert) -> Void) {
    self.deliver = deliver
  }

  public func load(_ tap: PushTap, api: any ScreenrAPI, avatars: PushAvatars) async {
    guard let id = tap.notificationID else {
      finish(.generic(.missingID))
      return
    }
    let notification: PushNotification
    do throws(APIError) {
      switch try await api.send(.notification(id: id)) {
      case .visible(let visible): notification = visible
      case .hidden:
        finish(.generic(.hidden))
        return
      }
    } catch {
      // The client's telemetry logs the failed request.
      finish(.generic(.failed))
      return
    }
    let content = PushContent(notification)
    let reading = progress.withLock { progress in
      guard case .reading = progress else { return false }
      progress = .loadingAvatar(content)
      return true
    }
    guard reading else { return }
    finish(.rich(content, avatar: await avatars.photo(of: content.sender)))
  }

  // The extension could not start its API client.
  public func unavailable(_ error: any Error) {
    Log.push.warning("The notification extension could not start", .error(error))
    finish(.generic(.failed))
  }

  // iOS is about to stop the extension, so the best alert so far goes now.
  public func timeWillExpire() {
    let alert = progress.withLock { progress -> PushAlert? in
      let alert: PushAlert? =
        switch progress {
        case .reading: .generic(.timedOut)
        case .loadingAvatar(let content): .rich(content, avatar: nil)
        case .delivered: nil
        }
      progress = .delivered
      return alert
    }
    if let alert { send(alert) }
  }

  private func finish(_ alert: PushAlert) {
    let first = progress.withLock { progress in
      if case .delivered = progress { return false }
      progress = .delivered
      return true
    }
    if first { send(alert) }
  }

  private func send(_ alert: PushAlert) {
    switch alert {
    case .rich(_, let avatar):
      Log.push.info("Showed a push's notification", .bool("avatar", avatar != nil))
    case .generic(let reason):
      Log.push.info("Kept a push's generic alert", .label("reason", reason))
    }
    deliver(alert)
  }
}

// Loads a push sender's profile photo for the alert's avatar.
public struct PushAvatars: Sendable {
  private let load: @Sendable (_ userId: String, _ version: String) async throws -> Data?

  // `load` returns the photo, or nil when there is none to load.
  public init(load: @escaping @Sendable (_ userId: String, _ version: String) async throws -> Data?)
  {
    self.load = load
  }

  // The server's photos, which `images` requests with the session's bearer
  // token, through `session`. Against the fixture API, `images` loads
  // nothing, so no avatar shows.
  public static func network(images: ImageSource, session: URLSession) -> PushAvatars {
    PushAvatars { userId, version in
      guard let request = await images.photo(userId: userId, version: version) else { return nil }
      let (data, response) = try await session.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw URLError(.badServerResponse)
      }
      return data
    }
  }

  // The sender's photo, or nil without one or when it fails to load.
  func photo(of sender: PushSender) async -> Data? {
    guard let version = sender.photo else { return nil }
    do {
      return try await load(sender.id, version)
    } catch {
      Log.push.info("A push's avatar did not load", .error(error))
      return nil
    }
  }
}
