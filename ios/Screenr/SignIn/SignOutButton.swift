import ScreenrKit
import SwiftUI

// Signs this device out. When the server confirms, the session ends and the
// app returns to the sign-in screen; otherwise the screen's
// `signOutFailure(_:)` alert says why.
struct SignOutButton: View {
  let model: SignOutModel

  var body: some View {
    Button {
      Task { await model.signOut() }
    } label: {
      Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
    }
    .disabled(model.state == .signingOut)
  }
}

extension View {
  // Why a sign-out failed. A screen keeps the model and presents this alert
  // outside content that a failed read replaces, so the alert stays up.
  func signOutFailure(_ model: SignOutModel) -> some View {
    modifier(SignOutFailureAlert(model: model))
  }
}

private struct SignOutFailureAlert: ViewModifier {
  let model: SignOutModel

  func body(content: Content) -> some View {
    content
      .alert(
        "Could not sign out",
        isPresented: Binding(
          get: { failure != nil },
          set: { if !$0 { model.dismissFailure() } }
        ),
        presenting: failure
      ) { _ in
        Button("OK", role: .cancel) { model.dismissFailure() }
      } message: { failure in
        Text(failure)
      }
  }

  // Read while rendering, so a new failure presents the alert.
  private var failure: String? {
    guard case .failed(let message) = model.state else { return nil }
    return message
  }
}
