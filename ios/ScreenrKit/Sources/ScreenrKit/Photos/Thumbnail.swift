import CoreGraphics
import Foundation
import ImageIO

// Decodes an image at the size a view draws it, with ImageIO, so the full
// image is never decoded, and the view draws the result without decoding it
// again. It never scales an image up.
enum Thumbnail {
  // The image scaled down until its longer side is at most `longSide` pixels.
  static func image(_ data: Data, longSide: Int) -> CGImage? {
    guard let source = source(data) else { return nil }
    return image(source, longSide: longSide)
  }

  // The image scaled down until its shorter side is `side` pixels, for a view
  // that fills a square with it, such as an avatar.
  static func image(_ data: Data, filling side: Int) -> CGImage? {
    guard let source = source(data),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      min(width, height) > 0
    else { return nil }
    let longSide = (side * max(width, height) + min(width, height) - 1) / min(width, height)
    return image(source, longSide: longSide)
  }

  private static func source(_ data: Data) -> CGImageSource? {
    let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
    return CGImageSourceCreateWithData(data as CFData, options as CFDictionary)
  }

  private static func image(_ source: CGImageSource, longSide: Int) -> CGImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: longSide,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
