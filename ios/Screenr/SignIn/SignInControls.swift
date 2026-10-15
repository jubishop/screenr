import AuthenticationServices
import ScreenrKit
import SwiftUI

// The sign-in methods a `SignInModel` offers: Sign in with Apple, Google,
// and the email code's two steps, with the last attempt's failure. The
// sign-in screen shows them, and so does confirming it's the member before
// deleting the account, which offers only the account's methods and sends
// the code to the account's address.
struct SignInControls: View {
  private enum Field: Hashable {
    case email
    case code
  }

  @Bindable var model: SignInModel
  @FocusState private var focus: Field?
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @Environment(\.colorScheme) private var colorScheme
  @ScaledMetric(relativeTo: .body) private var appleButtonHeight = 50.0

  var body: some View {
    VStack(spacing: 32) {
      if model.methods.contains(.apple) || model.methods.contains(.google) {
        providers
      }
      if model.methods.contains(.emailCode) {
        emailCode
      } else {
        failureMessage
      }
    }
    .onChange(of: model.step) { _, step in
      focus = step == .email ? .email : .code
    }
    .onChange(of: model.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }

  private var providers: some View {
    VStack(spacing: 12) {
      if model.methods.contains(.apple) { apple }
      if model.methods.contains(.google) {
        Button {
          Task {
            await model.signInWithGoogle(
              using: SystemWebAuthenticator(session: webAuthenticationSession)
            )
          }
        } label: {
          ProgressLabel(
            "Continue with Google",
            systemImage: "g.circle.fill",
            busy: model.activity == .google
          )
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
      }
      if model.methods.contains(.emailCode) {
        Text("or use an email code")
          .font(.subheadline)
          .padding(.top, 8)
      }
    }
    .disabled(model.activity != .idle)
  }

  @ViewBuilder private var apple: some View {
    switch model.authorization {
    case .system:
      SignInWithAppleButton(.signIn) { request in
        model.prepare(request)
      } onCompletion: { result in
        Task { await model.completeApple(result) }
      }
      .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
      .frame(height: appleButtonHeight)
    case .fixture:
      Button {
        Task { await model.signInWithFixtureApple() }
      } label: {
        ProgressLabel(
          "Sign in with Apple",
          systemImage: "apple.logo",
          busy: model.activity == .apple
        )
      }
      .buttonStyle(.accent)
      .controlSize(.large)
    }
  }

  @ViewBuilder private var emailCode: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch model.step {
      case .email:
        if let address = model.fixedEmail {
          Text("We’ll email a sign-in code to \(address).")
          failureMessage
          sendButton("Email me a code")
        } else {
          TextField("Email address", text: $model.email)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.send)
            .focused($focus, equals: .email)
            .onSubmit { submit(model.sendCode) }
            .textFieldStyle(.roundedBorder)
          failureMessage
          sendButton("Send sign-in code")
        }
      case .code(let email):
        Text("Enter the 6-digit code we sent to \(email).")
        TextField(
          "Sign-in code",
          text: Binding(get: { model.code }, set: { model.enterCode($0) })
        )
        .textContentType(.oneTimeCode)
        .keyboardType(.numberPad)
        .font(.title3.monospacedDigit())
        .focused($focus, equals: .code)
        .textFieldStyle(.roundedBorder)
        failureMessage
        Button {
          submit(model.checkCode)
        } label: {
          ProgressLabel(
            model.fixedEmail == nil ? "Sign in" : "Confirm code",
            busy: model.activity == .checkingCode
          )
        }
        .buttonStyle(.accent)
        .controlSize(.large)
        .disabled(!model.canCheckCode)
        Button(
          model.fixedEmail == nil
            ? "Use another email or request a new code" : "Request a new code"
        ) {
          model.useAnotherEmail()
        }
        .disabled(model.activity != .idle)
        .frame(maxWidth: .infinity)
      }
    }
  }

  private func sendButton(_ title: String) -> some View {
    Button {
      submit(model.sendCode)
    } label: {
      ProgressLabel(title, busy: model.activity == .sendingCode)
    }
    .buttonStyle(.accent)
    .controlSize(.large)
    .disabled(!model.canSendCode)
  }

  // Closes the keyboard, so the result shows, and sends the request.
  private func submit(_ request: @escaping @MainActor () async -> Void) {
    focus = nil
    Task { await request() }
  }

  @ViewBuilder private var failureMessage: some View {
    if let failure = model.failure {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.red)
          .accessibilityHidden(true)
        Text(failure)
      }
      .font(.callout)
    }
  }
}

// A full-width button label that shows a spinner while its request runs.
struct ProgressLabel: View {
  let title: String
  let systemImage: String?
  let busy: Bool

  init(_ title: String, systemImage: String? = nil, busy: Bool) {
    self.title = title
    self.systemImage = systemImage
    self.busy = busy
  }

  var body: some View {
    HStack(spacing: 8) {
      if busy {
        ProgressView()
      } else if let systemImage {
        Image(systemName: systemImage)
          .accessibilityHidden(true)
      }
      Text(title)
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(title)
    .accessibilityValue(busy ? "In progress" : "")
  }
}
