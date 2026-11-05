import Foundation

extension String {
  // The longest start of the text, in whole characters, within `limit` UTF-16
  // code units. The server counts text as JavaScript's `length` does, in
  // UTF-16 code units, so most emoji count as two.
  func prefix(utf16Limit limit: Int) -> String {
    guard utf16.count > limit else { return self }
    var units = 0
    let end =
      firstIndex { character in
        units += character.utf16.count
        return units > limit
      } ?? endIndex
    return String(self[..<end])
  }
}
