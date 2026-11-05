import SwiftUI
import UIKit

// A member's photo in a circle over their initial, which shows when there is
// no photo or it has not loaded. The member's name or a description appears
// beside it.
struct ProfilePhotoView: View {
  // The photo's JPEG, when it is here.
  let jpeg: Data?
  // The name whose first character is the initial.
  let name: String
  var size: CGFloat = 44
  // Each JPEG decodes once, not on every redraw, such as for each keystroke
  // in the name field beside it.
  @State private var decoded = DecodedPhoto()

  var body: some View {
    ZStack {
      Circle()
        .fill(.tint.opacity(0.18))
      Text(initial)
        .font(.system(size: size * 0.45, weight: .semibold))
        .foregroundStyle(.tint)
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      }
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
  }

  private var initial: String {
    guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "" }
    return String(first)
  }

  private var image: UIImage? { decoded.image(jpeg) }
}

// The last JPEG a photo view showed, and its image.
private final class DecodedPhoto {
  private var jpeg: Data?
  private var image: UIImage?

  func image(_ jpeg: Data?) -> UIImage? {
    guard jpeg != self.jpeg else { return image }
    self.jpeg = jpeg
    if let jpeg {
      image = UIImage(data: jpeg)
    } else {
      image = nil
    }
    return image
  }
}
