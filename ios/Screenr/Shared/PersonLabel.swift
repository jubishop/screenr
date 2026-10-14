import ScreenrKit
import SwiftUI

// A member in a list: their photo or initial, display name, and @username
// beneath. VoiceOver reads the name and username together.
struct PersonLabel: View {
  enum Detail {
    case username
    // A blocked person shows only their name, since blocking hides the
    // profile.
    case nameOnly
  }

  let person: Person
  var detail = Detail.username

  var body: some View {
    HStack(spacing: 12) {
      Avatar(person, size: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(person.displayName)
          .font(.body.weight(.semibold))
        if detail == .username {
          Text("@" + person.username)
            .font(.subheadline)
            .foregroundStyle(.muted)
        }
      }
      .multilineTextAlignment(.leading)
    }
    .accessibilityElement(children: .combine)
  }
}
