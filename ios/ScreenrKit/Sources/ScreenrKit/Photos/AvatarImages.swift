import CoreGraphics
import Foundation
import Synchronization

// Profile photos decoded at the size avatars draw them. `AsyncImage` would
// decode each 512-pixel photo whole, about 1 MB, for a 28 to 64 point
// circle, and again each time a list recreates its row. Photos load through
// the image session, whose cache keeps their files, and the decoded images
// stay in memory, within `limits`, until the session ends or memory runs low.
// Views read it with `@Environment(\.avatarImages)`.
public final class AvatarImages: Sendable {
  // About 220 avatars at the feed's 32 points on a 3× screen, 36 KB each,
  // which covers a member's friends at the sizes the screens show them.
  static let limits = CacheLimits(count: 256, bytes: 8 << 20)

  // Loads nothing, so avatars show their initials.
  public static let none = AvatarImages(load: nil)

  private let load: (@Sendable (URLRequest) async throws -> Data)?
  private let cache: RecentCache<CGImage>
  // Counts `removeAll()` calls, so a photo that the ended session loaded is
  // not kept for the next.
  private let generation = Mutex(0)

  // `load` returns a photo's file; `notifications` posts the system's memory
  // warnings.
  init(
    notifications: NotificationCenter = .default,
    load: (@Sendable (URLRequest) async throws -> Data)?
  ) {
    self.load = load
    cache = RecentCache(limits: Self.limits, notifications: notifications)
  }

  // Photos through `session`, as `ImageSource.photo(userId:version:)`
  // requests them.
  public static func network(session: URLSession) -> AvatarImages {
    AvatarImages { request in
      let (data, response) = try await session.data(for: request)
      if let response = response as? HTTPURLResponse, response.statusCode != 200 {
        throw URLError(.badServerResponse)
      }
      return data
    }
  }

  // The photo decoded `pixels` wide, when it is decoded already.
  public func cached(_ request: URLRequest, pixels: Int) -> CGImage? {
    guard let key = Self.key(request, pixels: pixels) else { return nil }
    return cache.value(for: key)
  }

  // The photo decoded `pixels` wide, loading it if needed, or nil when it
  // fails to load, so the avatar keeps its initial. It decodes off the
  // caller's actor.
  @concurrent
  public func image(_ request: URLRequest, pixels: Int) async -> CGImage? {
    guard let load, let key = Self.key(request, pixels: pixels) else { return nil }
    if let image = cache.value(for: key) { return image }
    let started = generation.withLock { $0 }
    let data: Data
    do {
      data = try await load(request)
    } catch {
      Log.app.debug("An avatar did not load", .error(error))
      return nil
    }
    guard let image = Thumbnail.image(data, filling: pixels) else {
      Log.app.debug("An avatar could not be decoded")
      return nil
    }
    generation.withLock { current in
      guard current == started else { return }
      cache.store(image, bytes: image.bytesPerRow * image.height, for: key)
    }
    return image
  }

  // Forgets every decoded photo, as when the session ends.
  public func removeAll() {
    generation.withLock { current in
      current += 1
      cache.removeAll()
    }
  }

  private static func key(_ request: URLRequest, pixels: Int) -> String? {
    guard let url = request.url else { return nil }
    return "\(pixels) \(url.absoluteString)"
  }
}
