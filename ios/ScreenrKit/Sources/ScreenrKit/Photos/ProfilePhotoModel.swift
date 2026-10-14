import Foundation
import Observation

// The signed-in member's own profile photo, during setup and in Settings, as
// on the web: add or replace it with a photo from the library, use Google's
// picture, or remove it. Each change saves at once. Until a photo loads, or
// when there is none, the member's initial shows.
@MainActor
@Observable
public final class ProfilePhotoModel {
  // The change in flight, if any. Only one runs at a time.
  public enum Activity: Hashable, Sendable {
    case idle
    case uploading
    case copyingGoogle
    case removing
  }

  public private(set) var userId: String?
  // The server's photo version, or nil while the initial shows.
  public private(set) var version: String?
  // The current photo's JPEG, once downloaded or saved from this device.
  public private(set) var jpeg: Data?
  // Whether Google can supply a photo, which shows "Use my Google photo".
  public private(set) var google = false
  public private(set) var activity = Activity.idle
  // What the last change did, such as "Photo added.", in words for the member.
  public private(set) var status: String?
  // Why the last change failed, in words for the member.
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI

  public init(api: any ScreenrAPI) {
    self.api = api
  }

  public var hasPhoto: Bool { version != nil }

  // The photo as the server last reported it, such as in setup's details or
  // on the account screen.
  public func show(userId: String, version: String?, google: Bool) {
    if self.userId != userId || self.version != version { jpeg = nil }
    self.userId = userId
    self.version = version
    self.google = google
  }

  // Downloads the current photo, unless it is already here. A photo that
  // cannot load leaves the initial, as on the web.
  public func loadPhoto() async {
    guard jpeg == nil, let userId, let version else { return }
    do throws(APIError) {
      let data = try await api.send(.photo(userId: userId, version: version))
      if self.userId == userId, self.version == version { jpeg = data }
    } catch {
      return
    }
  }

  // Crops, sizes, and saves a photo from the library.
  public func upload(_ image: Data) async {
    guard activity == .idle else { return }
    begin(.uploading)
    defer { activity = .idle }
    await save(image)
  }

  // Saves the photo the member chose once `load` reads it from the library,
  // which can take a moment for a photo kept in iCloud.
  public func upload(loading load: @escaping @Sendable () async throws -> Data?) async {
    guard activity == .idle else { return }
    begin(.uploading)
    defer { activity = .idle }
    let image: Data?
    do {
      image = try await load()
    } catch {
      failure = PhotoPreparation.Failure.unreadable.message
      return
    }
    guard let image else {
      failure = PhotoPreparation.Failure.unreadable.message
      return
    }
    await save(image)
  }

  private func save(_ image: Data) async {
    let replacing = hasPhoto
    let prepared: Data
    do throws(PhotoPreparation.Failure) {
      prepared = try await PhotoPreparation.jpeg(from: image)
    } catch {
      failure = error.message
      return
    }
    do throws(APIError) {
      version = try await api.send(.uploadPhoto(jpeg: prepared)).photo
      jpeg = prepared
      status = replacing ? "Photo replaced." : "Photo added."
    } catch {
      failure = error.explanation(otherwise: "Could not save the photo. Try again.")
    }
  }

  // Copies the Google account's picture.
  public func useGoogle() async {
    guard activity == .idle else { return }
    begin(.copyingGoogle)
    defer { activity = .idle }
    do throws(APIError) {
      let saved = try await api.send(.googlePhoto).photo
      if saved != version { jpeg = nil }
      version = saved
      status = "Google photo added."
    } catch {
      failure = error.explanation(otherwise: "Could not copy your Google photo. Try again.")
    }
  }

  public func remove() async {
    guard activity == .idle else { return }
    begin(.removing)
    defer { activity = .idle }
    do throws(APIError) {
      version = try await api.send(.removePhoto).photo
      jpeg = nil
      status = "Photo removed."
    } catch {
      failure = error.explanation(otherwise: "Could not remove the photo. Try again.")
    }
  }

  private func begin(_ activity: Activity) {
    self.activity = activity
    status = nil
    failure = nil
  }
}
