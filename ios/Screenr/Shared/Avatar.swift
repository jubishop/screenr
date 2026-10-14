import ScreenrKit
import SwiftUI

// A member's profile photo, or their initial on a color their user ID picks,
// so renaming keeps it. It always sits beside their visible name, so it is
// decorative. A person who is not available gets a neutral placeholder.
struct Avatar: View {
  struct Member: Hashable {
    let userId: String
    let name: String
    let photo: String?
  }

  let member: Member?
  var size: CGFloat = 32
  @Environment(\.imageSource) private var images
  @ScaledMetric private var scale: CGFloat = 1

  init(_ member: Member?, size: CGFloat = 32) {
    self.member = member
    self.size = size
  }

  init(_ person: Person, size: CGFloat = 32) {
    self.init(
      Member(userId: person.userId, name: person.displayName, photo: person.photo),
      size: size
    )
  }

  var body: some View {
    Group {
      if let member {
        AsyncImage(request: images.photo(userId: member.userId, version: member.photo)) { phase in
          // AsyncImage hosts its content apart, so it is hidden here too.
          if case .success(let image) = phase {
            image.resizable().scaledToFill().accessibilityHidden(true)
          } else {
            initial(member).accessibilityHidden(true)
          }
        }
      } else {
        Image(systemName: "person.fill")
          .font(.system(size: size * scale * 0.5))
          .foregroundStyle(.muted)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(uiColor: .secondarySystemFill))
      }
    }
    .frame(width: size * scale, height: size * scale)
    .clipShape(Circle())
    .accessibilityHidden(true)
  }

  private func initial(_ member: Member) -> some View {
    Text(String(member.name.prefix(1)))
      .font(size >= 40 ? .title3.weight(.semibold) : .subheadline.weight(.semibold))
      .foregroundStyle(.primary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Self.tones[Self.tone(member.userId)])
  }

  // The web's palette, light and dark, so a person's color matches there.
  private static let tones: [Color] = [
    (0xDCE6CF, 0x35503F), (0xE9DFC9, 0x55492F), (0xD3E4E3, 0x2E4F4E), (0xECD9D3, 0x5A3C36),
    (0xDFDBEC, 0x463F5E), (0xE4E8C4, 0x4B532D), (0xD6E0EC, 0x34495F), (0xEEDCC0, 0x5E4429),
  ]
  .map { light, dark in
    Color(
      uiColor: UIColor { traits in
        UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
      }
    )
  }

  // The web's hash: a 31-multiplier over UTF-16 code units, kept to 32 bits.
  static func tone(_ userId: String) -> Int {
    var hash: UInt32 = 0
    for unit in userId.utf16 { hash = hash &* 31 &+ UInt32(unit) }
    return Int(hash % UInt32(tones.count))
  }
}

extension Avatar.Member {
  init(_ item: FeedItem) {
    self.init(userId: item.ownerId, name: item.displayName, photo: item.photo)
  }

  // A comment's author, or nil for an unavailable or deleted author.
  init?(_ comment: Comment) {
    guard !comment.unavailable, let userId = comment.authorId else { return nil }
    self.init(userId: userId, name: comment.displayName ?? "", photo: comment.photo)
  }
}

extension UIColor {
  fileprivate convenience init(hex: Int) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1
    )
  }
}
