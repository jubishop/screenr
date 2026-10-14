import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// A stand-in for a photo from the library. UI tests cannot drive the system
// photo picker, so under the fixture API, Screenr Dev's photo editor chooses
// this photo instead. It is a portrait JPEG of a gradient under heavy noise,
// which compresses about as poorly as a detailed camera photo, so the upload
// goes through the same preparation as a real one.
public enum FixturePhoto {
  public static func jpeg() throws(PhotoPreparation.Failure) -> Data {
    try encode(image(width: 900, height: 1200, noise: 96), quality: 0.92)
  }

  // A gradient with random noise of up to `noise` in each channel, the same
  // on every run.
  static func image(width: Int, height: Int, noise: Int) throws(PhotoPreparation.Failure) -> CGImage
  {
    var random = SeededRandom(seed: 0x5C7E_E212)
    func jitter(_ value: Int) -> UInt8 {
      UInt8(clamping: noise > 0 ? value + random.next(below: noise * 2 + 1) - noise : value)
    }
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for y in 0..<height {
      let green = y * 255 / max(height - 1, 1)
      for x in 0..<width {
        let index = (y * width + x) * 4
        bytes[index] = jitter(x * 255 / max(width - 1, 1))
        bytes[index + 1] = jitter(green)
        bytes[index + 2] = jitter(128)
      }
    }
    // The initializer's only pointer argument, `decode`, is nil.
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = unsafe CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: space,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
      )
    else { throw .unconvertible }
    return image
  }

  // `properties` adds metadata, such as an EXIF orientation or a location.
  static func encode(
    _ image: CGImage,
    quality: Double,
    type: UTType = .jpeg,
    properties: [CFString: Any] = [:]
  ) throws(PhotoPreparation.Failure) -> Data {
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output as CFMutableData,
        type.identifier as CFString,
        1,
        nil
      )
    else { throw .unconvertible }
    var options = properties
    options[kCGImageDestinationLossyCompressionQuality] = quality
    CGImageDestinationAddImage(destination, image, options as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw .unconvertible }
    return output as Data
  }
}

// A small deterministic generator (SplitMix64), so the photo is the same on
// every run.
struct SeededRandom {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }

  // A value from 0 up to, but not including, `bound`.
  mutating func next(below bound: Int) -> Int {
    Int(next() % UInt64(bound))
  }
}
