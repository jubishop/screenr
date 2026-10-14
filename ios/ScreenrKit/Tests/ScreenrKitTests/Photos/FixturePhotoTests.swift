import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import ScreenrKit

// The photo that UI tests choose in place of the photo library, and what
// preparing a photo leaves out of the upload.
struct FixturePhotoTests {
  @Test func preparesTheFixturePhotoUnderTheLimit() async throws {
    let photo = try FixturePhoto.jpeg()

    let jpeg = try await PhotoPreparation.jpeg(from: photo)

    let source = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(jpeg.count <= PhotoPreparation.limit)
    #expect(image.width == image.height)
    #expect(try FixturePhoto.jpeg() == photo)
  }

  // The JPEG is drawn anew, so the original's location and camera details
  // never reach the server.
  @Test func leavesOutTheOriginalsMetadata() async throws {
    let located = try FixturePhoto.encode(
      try FixturePhoto.image(width: 800, height: 600, noise: 16),
      quality: 0.9,
      properties: [
        kCGImagePropertyGPSDictionary: [
          kCGImagePropertyGPSLatitude: 37.77, kCGImagePropertyGPSLatitudeRef: "N",
          kCGImagePropertyGPSLongitude: 122.42, kCGImagePropertyGPSLongitudeRef: "W",
        ],
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFModel: "iPhone"],
      ]
    )
    #expect(try properties(located)[kCGImagePropertyGPSDictionary] != nil)

    let jpeg = try await PhotoPreparation.jpeg(from: located)

    let prepared = try properties(jpeg)
    #expect(prepared[kCGImagePropertyGPSDictionary] == nil)
    #expect(prepared[kCGImagePropertyTIFFDictionary] == nil)
  }

  private func properties(_ data: Data) throws -> [CFString: Any] {
    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
  }
}
