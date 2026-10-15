import CoreGraphics
import XCTest

extension XCUIElement {
  // The WCAG contrast ratio between a filled button's label and its fill, from
  // a screenshot of the button's middle, away from its rounded ends: the fill
  // is the most common color there, and the label the color whose luminance
  // is farthest from it. The accessibility audit judges contrast in the
  // Simulator's appearance, which changes for its apps only after it
  // restarts, so it misses colors that only `FixtureLaunch(appearance:)`
  // shows.
  @MainActor
  func labelContrast() throws -> Double {
    let image = try XCTUnwrap(screenshot().image.cgImage)
    let pixels = try XCTUnwrap(image.dataProvider?.data as Data?)
    guard image.bitsPerComponent == 8, image.bitsPerPixel == 32 else {
      throw ContrastError(description: "Unexpected pixel format \(image.bitmapInfo)")
    }
    let channels = try Self.channelOffsets(image)
    var counts: [Int: Int] = [:]
    var luminances: [Int: Double] = [:]
    for y in image.height / 4..<image.height * 3 / 4 {
      for x in image.width / 5..<image.width * 4 / 5 {
        let pixel = y * image.bytesPerRow + x * 4
        let rgb = channels.map { Int(pixels[pixel + $0]) }
        let key = rgb[0] << 16 | rgb[1] << 8 | rgb[2]
        counts[key, default: 0] += 1
        if luminances[key] == nil { luminances[key] = Self.luminance(rgb) }
      }
    }
    let fill = try XCTUnwrap(counts.max { $0.value < $1.value }?.key)
    let fillLuminance = try XCTUnwrap(luminances[fill])
    let label = try XCTUnwrap(
      luminances.values.max { abs($0 - fillLuminance) < abs($1 - fillLuminance) }
    )
    return (max(fillLuminance, label) + 0.05) / (min(fillLuminance, label) + 0.05)
  }

  // Where red, green, and blue sit in each pixel's four bytes.
  private static func channelOffsets(_ image: CGImage) throws -> [Int] {
    let alphaFirst: Bool
    switch image.alphaInfo {
    case .first, .premultipliedFirst, .noneSkipFirst: alphaFirst = true
    case .last, .premultipliedLast, .noneSkipLast: alphaFirst = false
    default: throw ContrastError(description: "Unexpected alpha \(image.alphaInfo)")
    }
    switch (image.byteOrderInfo, alphaFirst) {
    case (.order32Little, true): return [2, 1, 0]
    case (.order32Little, false): return [3, 2, 1]
    case (.orderDefault, true), (.order32Big, true): return [1, 2, 3]
    case (.orderDefault, false), (.order32Big, false): return [0, 1, 2]
    default: throw ContrastError(description: "Unexpected byte order \(image.byteOrderInfo)")
    }
  }

  // WCAG relative luminance of an sRGB color.
  private static func luminance(_ rgb: [Int]) -> Double {
    let linear = rgb.map { channel in
      let value = Double(channel) / 255
      return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }
}

struct ContrastError: Error, CustomStringConvertible {
  let description: String
}
