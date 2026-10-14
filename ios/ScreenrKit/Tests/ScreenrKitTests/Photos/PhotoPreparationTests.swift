import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import ScreenrKit

// A library photo becomes the center square as a JPEG that fits the upload
// limit, as on the web.
struct PhotoPreparationTests {
  @Test func cropsTheCenterSquareTo512Pixels() async throws {
    // Red bands on both sides of a blue square, which the crop keeps.
    let image = try Self.encode(
      Self.image(width: 900, height: 300) { x, _ in x < 300 || x >= 600 ? .red : .blue },
      as: .png
    )

    let jpeg = try await PhotoPreparation.jpeg(from: image)

    let prepared = try Self.decode(jpeg)
    #expect(prepared.type == UTType.jpeg.identifier)
    #expect(prepared.image.width == 512)
    #expect(prepared.image.height == 512)
    #expect(jpeg.count <= PhotoPreparation.limit)
    for (x, y) in [(10, 10), (256, 256), (500, 500), (10, 500)] {
      let pixel = try Self.pixel(of: prepared.image, x: x, y: y)
      #expect(pixel.blue > 200 && pixel.red < 60, "\(x), \(y): \(pixel)")
    }
  }

  @Test func lowersTheQualityOrSizeUntilTheJPEGFits() async throws {
    // Noise compresses poorly, so the first attempts are too large.
    var seed: UInt32 = 7
    let noise = try Self.encode(
      Self.image(width: 1200, height: 1200) { _, _ in
        seed = seed &* 1_664_525 &+ 1_013_904_223
        return Self.Color(
          red: UInt8(seed >> 24),
          green: UInt8(seed >> 16 & 0xFF),
          blue: UInt8(seed >> 8 & 0xFF)
        )
      },
      as: .png
    )

    let jpeg = try await PhotoPreparation.jpeg(from: noise)

    let prepared = try Self.decode(jpeg)
    #expect(jpeg.count <= PhotoPreparation.limit)
    #expect(prepared.image.width == prepared.image.height)
    #expect([512, 384, 256].contains(prepared.image.width))
  }

  @Test func turnsAPhotoUpright() async throws {
    // Stored sideways, with the top band on the right, and an orientation
    // that turns it a quarter turn counterclockwise to show.
    let sideways = Self.image(width: 400, height: 400) { x, _ in x >= 300 ? .red : .blue }
    let data = try Self.encode(sideways, as: .jpeg, orientation: 8)

    let prepared = try Self.decode(try await PhotoPreparation.jpeg(from: data))

    let top = try Self.pixel(of: prepared.image, x: 256, y: 20)
    let bottom = try Self.pixel(of: prepared.image, x: 256, y: 490)
    #expect(top.red > 200 && top.blue < 60, "\(top)")
    #expect(bottom.blue > 200 && bottom.red < 60, "\(bottom)")
  }

  @Test func rejectsWhatIsNotAnImage() async {
    await #expect(throws: PhotoPreparation.Failure.unreadable) {
      try await PhotoPreparation.jpeg(from: Data("not a photo".utf8))
    }
  }

  // MARK: - Images

  struct Color: CustomStringConvertible {
    let red: UInt8
    let green: UInt8
    let blue: UInt8

    static let red = Color(red: 255, green: 0, blue: 0)
    static let blue = Color(red: 0, green: 0, blue: 255)

    var description: String { "rgb(\(red), \(green), \(blue))" }
  }

  struct Pixels {
    let width: Int
    let height: Int
    // RGBA, row by row from the top.
    let bytes: [UInt8]
  }

  struct ImageError: Error {}

  static func image(width: Int, height: Int, color: (Int, Int) -> Color) -> Pixels {
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for y in 0..<height {
      for x in 0..<width {
        let pixel = color(x, y)
        let offset = (y * width + x) * 4
        bytes[offset] = pixel.red
        bytes[offset + 1] = pixel.green
        bytes[offset + 2] = pixel.blue
      }
    }
    return Pixels(width: width, height: height, bytes: bytes)
  }

  // Encodes pixels as a PNG, or as a JPEG with an EXIF orientation.
  static func encode(_ pixels: Pixels, as type: UTType, orientation: Int = 1) throws -> Data {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let provider = CGDataProvider(data: Data(pixels.bytes) as CFData),
      let image = unsafe CGImage(
        width: pixels.width,
        height: pixels.height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: pixels.width * 4,
        space: space,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
      )
    else { throw ImageError() }
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data as CFMutableData,
        type.identifier as CFString,
        1,
        nil
      )
    else { throw ImageError() }
    let properties: [CFString: Any] = [
      kCGImagePropertyOrientation: orientation,
      kCGImageDestinationLossyCompressionQuality: 1.0,
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw ImageError() }
    return data as Data
  }

  static func decode(_ data: Data) throws -> (image: CGImage, type: String) {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let type = CGImageSourceGetType(source)
    else { throw ImageError() }
    return (image, type as String)
  }

  // The pixel `x` across and `y` down from the top left.
  static func pixel(of image: CGImage, x: Int, y: Int) throws -> Color {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let context = unsafe CGContext(
        data: nil,
        width: 1,
        height: 1,
        bitsPerComponent: 8,
        bytesPerRow: 4,
        space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
      )
    else { throw ImageError() }
    // Moves the wanted pixel onto the context's one pixel. Core Graphics
    // counts rows from the bottom.
    context.draw(
      image,
      in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height)
    )
    guard let data = context.makeImage()?.dataProvider?.data as Data?, data.count >= 3 else {
      throw ImageError()
    }
    return Color(red: data[0], green: data[1], blue: data[2])
  }
}
