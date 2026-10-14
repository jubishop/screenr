import SwiftUI

// A destructive action's label, such as Remove photo or Revoke invitation.
// The system's red falls short of 4.5:1 contrast in a list row and on a
// bordered button's gray fill, so the label uses `.danger`, and muted text
// while the action is unavailable, which keeps that contrast too.
struct DestructiveLabel: View {
  let title: String
  let systemImage: String
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Label(title, systemImage: systemImage)
      .foregroundStyle(isEnabled ? Color.danger : Color.muted)
  }
}
