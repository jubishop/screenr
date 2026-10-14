import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Turns a photo from the library into the profile photo the server stores, as
// the web does: the center square, upright, as a 512×512 JPEG under 60 KB,
// which fits Caddy's 64 KB request limit. It lowers the quality, and then the
// size, until the JPEG fits, so the server needs no image library.
public enum PhotoPreparation {
  public static let limit = 60 * 1024
  static let sides = [512, 384, 256]
  static let qualities = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3, 0.22, 0.14, 0.06]
  // Decoding no more than this many pixels on the long side keeps a large
  // camera photo's memory small; the crop needs far fewer.
  static let decodedSide = 2048

  public enum Failure: Error, Hashable, Sendable {
    // The data is not an image the system can read.
    case unreadable
    // Drawing or encoding the JPEG failed.
    case unconvertible
    // Even the smallest JPEG is over the limit.
    case tooLarge

    public var message: String {
      switch self {
      case .unreadable: "This photo could not be opened. Choose another photo."
      case .unconvertible: "This iPhone could not convert the photo. Choose another photo."
      case .tooLarge: "This photo could not be made small enough. Try another."
      }
    }
  }

  // Runs off the caller's actor, since decoding and encoding take a moment.
  @concurrent
  public static func jpeg(from data: Data) async throws(Failure) -> Data {
    try prepare(data)
  }

  static func prepare(_ data: Data) throws(Failure) -> Data {
    let square = try centerSquare(of: data)
    for side in sides {
      guard let resized = draw(square, side: side) else { throw .unconvertible }
      for quality in qualities {
        guard let jpeg = encode(resized, quality: quality) else { throw .unconvertible }
        if jpeg.count <= limit { return jpeg }
      }
    }
    throw .tooLarge
  }

  // The image turned upright by its orientation, cropped to its center square.
  private static func centerSquare(of data: Data) throws(Failure) -> CGImage {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: decodedSide,
    ]
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { throw .unreadable }
    let side = min(image.width, image.height)
    let crop = CGRect(
      x: (image.width - side) / 2,
      y: (image.height - side) / 2,
      width: side,
      height: side
    )
    guard let square = image.cropping(to: crop) else { throw .unconvertible }
    return square
  }

  // JPEG has no transparency, so transparent areas become white.
  private static func draw(_ image: CGImage, side: Int) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = unsafe CGContext(
        data: nil,
        width: side,
        height: side,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: side, height: side)
    context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
    context.fill(bounds)
    context.interpolationQuality = .high
    context.draw(image, in: bounds)
    return context.makeImage()
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
