import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Turns a screenshot from the library into the JPEG that feedback attaches: upright, at most
// 2048 pixels on its long side, and under 1 MB. It lowers the size and quality until the JPEG
// fits. The JPEG is drawn from the pixels alone, so the library's metadata, such as a photo's
// location, stays on the iPhone.
public enum ScreenshotPreparation {
  public static let limit = 1024 * 1024
  static let attempts: [(side: Int, quality: Double)] = [
    (2048, 0.8), (2048, 0.65), (1600, 0.65), (1280, 0.6), (1024, 0.5),
  ]

  // Runs off the caller's actor, since decoding and encoding take a moment.
  @concurrent
  public static func jpeg(from data: Data) async throws(PhotoPreparation.Failure) -> Data {
    try prepare(data)
  }

  static func prepare(_ data: Data) throws(PhotoPreparation.Failure) -> Data {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      CGImageSourceGetCount(source) > 0
    else { throw .unreadable }
    for attempt in attempts {
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: attempt.side,
      ]
      guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
      else { throw .unreadable }
      guard let jpeg = encode(image, quality: attempt.quality) else { throw .unconvertible }
      if jpeg.count <= limit { return jpeg }
    }
    throw .tooLarge
  }

  private static func encode(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        UTType.jpeg.identifier as CFString,
        1,
        nil
      )
    else { return nil }
    let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
