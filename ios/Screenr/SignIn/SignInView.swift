import ScreenrKit
import SwiftUI

// The signed-out screen: Sign in with Apple, Google, and an email code. A
// sign-in that succeeds moves the session to signed in, and the app shell
// replaces this screen. After the member deletes their account, it says so,
// as the web's sign-in page does.
struct SignInView: View {
  @Environment(\.screenrAPI) private var api
  @Environment(PendingInvitation.self) private var invitation
  @Environment(SessionStore.self) private var session
  @Environment(\.identityProviders) private var providers

  var body: some View {
    SignInForm(
      model: SignInModel(api: api, invitation: invitation, providers: injectedProviders),
      ending: session.ending
    )
  }

  private var injectedProviders: IdentityProviders {
    guard let providers else {
      preconditionFailure("Inject the services with .screenrServices(_:) before signing in")
    }
    return providers
  }
}

private struct SignInForm: View {
  @State private var model: SignInModel
  let ending: SessionStore.Ending?

  init(model: SignInModel, ending: SessionStore.Ending?) {
    _model = State(initialValue: model)
    self.ending = ending
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 32) {
        header
        SignInControls(model: model)
        Text("No password to remember. Your conversations stay within your circle.")
          .font(.footnote)
          .multilineTextAlignment(.center)
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 40)
      .frame(maxWidth: 480)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(Color(uiColor: .systemBackground))
  }

  private var header: some View {
    VStack(spacing: 12) {
      Wordmark()
      if ending == .accountDeleted {
        Notice(
          "Your Screenr account was deleted.",
          systemImage: "checkmark.circle.fill",
          color: .accentColor
        )
      }
      Text("Your next great watch starts with a friend.")
        .font(.title2.weight(.bold))
        .multilineTextAlignment(.center)
      Text(
        model.isInvited
          ? "You’re invited. Sign in to find your people and something worth watching."
          : "Welcome back. Sign in to your circle. New members need an invitation."
      )
      .multilineTextAlignment(.center)
      if let notice = model.invitationNotice {
        Notice(notice, systemImage: "exclamationmark.triangle.fill", color: .red)
      }
    }
  }
}

// A line about how the member arrived here, read aloud when it appears.
private struct Notice: View {
  let text: String
  let systemImage: String
  let color: Color

  init(_ text: String, systemImage: String, color: Color) {
    self.text = text
    self.systemImage = systemImage
    self.color = color
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: systemImage)
        .foregroundStyle(color)
        .accessibilityHidden(true)
      Text(text)
    }
    .font(.callout)
    .multilineTextAlignment(.center)
    .onAppear { AccessibilityNotification.Announcement(text).post() }
  }
}
