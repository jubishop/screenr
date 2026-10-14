import ScreenrKit
import SwiftUI

// The sign-in screen while signed out. Signed in, a placeholder with the
// wordmark and a way to sign out stands where the app's tabs will go.
struct AppRoot: View {
  @Environment(SessionStore.self) private var session

  var body: some View {
    switch session.phase {
    case .signedOut:
      SignInView()
    case .signedIn, .updateRequired:
      WordmarkView()
        .overlay(alignment: .bottom) {
          SignOutButton()
            .padding(.bottom, 32)
        }
    }
  }
}
