import ScreenrKit
import SwiftUI

// A member's profile photo, or their initial on a color their user ID picks,
// so renaming keeps it. It always sits beside their visible name. It stays out
// of the accessibility tree, so the initial never joins the label of a row or
// link around it, which UI tests find it by. A person who is not available
// gets a neutral placeholder. The photo is decoded at the avatar's size, once
// for every avatar of that size, and the initial shows until it loads.
struct Avatar: View {
  struct Member: Hashable {
    let userId: String
    let name: String
    let photo: String?
  }

  // A decoded photo, and the request and size it was decoded for.
  private struct Photo {
    let url: URL?
    let pixels: Int
    let image: CGImage
  }

  let member: Member?
  var size: CGFloat = 32
  @Environment(\.imageSource) private var images
  @Environment(\.avatarImages) private var avatars
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric private var scale: CGFloat = 1
  @State private var photo: Photo?

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
        photoOrInitial(member)
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

  private func photoOrInitial(_ member: Member) -> some View {
    let request = images.photo(userId: member.userId, version: member.photo)
    let pixels = Int((size * scale * displayScale).rounded(.up))
    return Group {
      if let image = image(request, pixels: pixels) {
        Image(decorative: image, scale: displayScale).resizable().scaledToFill()
      } else {
        initial(member)
      }
    }
    // The avatar keeps its photo, which the shared cache may let go.
    .task(id: "\(pixels) \(request?.url?.absoluteString ?? "")") {
      guard let request, let image = await avatars.image(request, pixels: pixels),
        photo?.image !== image
      else { return }
      photo = Photo(url: request.url, pixels: pixels, image: image)
    }
  }

  // The photo this avatar holds, or one another avatar of its size decoded.
  private func image(_ request: URLRequest?, pixels: Int) -> CGImage? {
    guard let request else { return nil }
    if let photo, photo.url == request.url, photo.pixels == pixels { return photo.image }
    return avatars.cached(request, pixels: pixels)
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
