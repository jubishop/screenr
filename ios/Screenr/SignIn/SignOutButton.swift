import ScreenrKit
import SwiftUI

// Signs this device out. When the server confirms, the session ends and the
// app returns to the sign-in screen; otherwise an alert says why.
struct SignOutButton: View {
  @Environment(\.screenrAPI) private var api

  var body: some View {
    SignOutControl(model: SignOutModel(api: api))
  }
}

private struct SignOutControl: View {
  @State private var model: SignOutModel

  init(model: SignOutModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    Button {
      Task { await model.signOut() }
    } label: {
      Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
    }
    .disabled(model.state == .signingOut)
    .alert(
      "Could not sign out",
      isPresented: Binding(get: { failure != nil }, set: { _ in model.dismissFailure() }),
      presenting: failure
    ) { _ in
      Button("OK", role: .cancel) { model.dismissFailure() }
    } message: { failure in
      Text(failure)
    }
  }

  private var failure: String? {
    guard case .failed(let message) = model.state else { return nil }
    return message
  }
}
