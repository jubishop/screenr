import CoreGraphics
import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// Avatars decode each profile photo once, at the size they draw it, and keep
// the result until the session ends or memory runs low.
@MainActor
struct AvatarImagesTests {
  private static let photo = URLRequest(
    url: URL(filePath: "/api/photos/user-ben/486e0212c15728ee")
  )

  // A 512×512 JPEG, the size of every profile photo, and how often it loaded.
  private final class Photos: Sendable {
    let notifications = NotificationCenter()
    private let loads = Mutex(0)
    private let jpeg: Data

    init(width: Int = 512, height: Int = 512) throws {
      jpeg = try FixturePhoto.encode(
        FixturePhoto.image(width: width, height: height, noise: 0),
        quality: 0.8
      )
    }

    var count: Int { loads.withLock { $0 } }

    func images() -> AvatarImages {
      AvatarImages(notifications: notifications) { [self] _ in
        loads.withLock { $0 += 1 }
        return jpeg
      }
    }
  }

  @Test func decodesAPhotoOnceAtTheAvatarsSize() async throws {
    let photos = try Photos()
    let avatars = photos.images()
    #expect(avatars.cached(Self.photo, pixels: 96) == nil)

    let image = try #require(await avatars.image(Self.photo, pixels: 96))
    let again = await avatars.image(Self.photo, pixels: 96)

    #expect(image.width == 96)
    #expect(image.height == 96)
    #expect(again === image)
    #expect(avatars.cached(Self.photo, pixels: 96) === image)
    #expect(photos.count == 1)

    // A larger avatar decodes its own, but never past the photo's size.
    let large = try #require(await avatars.image(Self.photo, pixels: 768))
    #expect(large.width == 512)
    #expect(photos.count == 2)
  }

  // An avatar fills its circle, so a photo that is not square covers it.
  @Test func coversTheCircleWithAPhotoThatIsNotSquare() async throws {
    let avatars = try Photos(width: 400, height: 200).images()

    let image = try #require(await avatars.image(Self.photo, pixels: 50))

    #expect(image.width == 100)
    #expect(image.height == 50)
  }

  @Test func forgetsEveryPhotoWhenMemoryRunsLow() async throws {
    let photos = try Photos()
    let avatars = photos.images()
    _ = await avatars.image(Self.photo, pixels: 96)

    photos.notifications.post(name: .memoryWarning, object: nil)

    #expect(avatars.cached(Self.photo, pixels: 96) == nil)
  }

  @Test func keepsTheInitialWhenAPhotoFails() async {
    let avatars = AvatarImages(notifications: NotificationCenter()) { _ in
      throw URLError(.notConnectedToInternet)
    }

    #expect(await avatars.image(Self.photo, pixels: 96) == nil)
    #expect(avatars.cached(Self.photo, pixels: 96) == nil)
  }

  // The next member sees none of the decoded photos the last one loaded.
  @Test func forgetsEveryPhotoWhenTheSessionEnds() async throws {
    let session = try SessionStore(keychain: InMemoryKeychain(token: "signed-token"))
    let services = AppServices(
      api: RecordingAPI([:]),
      session: session,
      identity: IdentityProviders(
        authorization: .system,
        google: GoogleSignIn(
          clientID: GoogleSignInTests.clientID,
          transport: RecordingTransport([])
        )
      )
    )
    let jpeg = try FixturePhoto.encode(
      FixturePhoto.image(width: 512, height: 512, noise: 0),
      quality: 0.8
    )
    let photo = URLRequest(
      url: try #require(URL(string: "data:image/jpeg;base64,\(jpeg.base64EncodedString())"))
    )
    _ = try #require(await services.avatars.image(photo, pixels: 96))
    #expect(services.avatars.cached(photo, pixels: 96) != nil)

    try session.end(token: "signed-token")

    #expect(services.avatars.cached(photo, pixels: 96) == nil)
  }
}
