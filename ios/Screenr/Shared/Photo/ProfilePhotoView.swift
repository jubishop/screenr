import SwiftUI
import UIKit

// A member's photo in a circle over their initial, which shows when there is
// no photo or it has not loaded. It is decorative: the member's name or a
// description appears beside it.
struct ProfilePhotoView: View {
  // The photo's JPEG, when it is here.
  let jpeg: Data?
  // The name whose first character is the initial.
  let name: String
  var size: CGFloat = 44

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
    .accessibilityHidden(true)
  }

  private var initial: String {
    guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines).first else { return "" }
    return String(first)
  }

  private var image: UIImage? {
    guard let jpeg else { return nil }
    return UIImage(data: jpeg)
  }
}
