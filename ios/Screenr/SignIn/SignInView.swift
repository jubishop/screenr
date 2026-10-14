import AuthenticationServices
import ScreenrKit
import SwiftUI

// The signed-out screen: Sign in with Apple, Google, and an email code. A
// sign-in that succeeds moves the session to signed in, and the app shell
// replaces this screen.
struct SignInView: View {
  @Environment(\.screenrAPI) private var api
  @Environment(PendingInvitation.self) private var invitation
  @Environment(\.identityProviders) private var providers

  var body: some View {
    SignInForm(model: SignInModel(api: api, invitation: invitation, providers: injectedProviders))
  }

  private var injectedProviders: IdentityProviders {
    guard let providers else {
      preconditionFailure("Inject the services with .screenrServices(_:) before signing in")
    }
    return providers
  }
}

private struct SignInForm: View {
  private enum Field: Hashable {
    case email
    case code
  }

  @State private var model: SignInModel
  @FocusState private var focus: Field?
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @Environment(\.colorScheme) private var colorScheme
  @ScaledMetric(relativeTo: .body) private var appleButtonHeight = 50.0

  init(model: SignInModel) {
    _model = State(initialValue: model)
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 32) {
        header
        providers
        emailCode
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
    .onChange(of: model.step) { _, step in
      focus = step == .email ? .email : .code
    }
    .onChange(of: model.failure) { _, failure in
      if let failure { AccessibilityNotification.Announcement(failure).post() }
    }
  }

  private var header: some View {
    VStack(spacing: 12) {
      Wordmark()
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
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.red)
            .accessibilityHidden(true)
          Text(notice)
        }
        .font(.callout)
        .multilineTextAlignment(.center)
        .onAppear { AccessibilityNotification.Announcement(notice).post() }
      }
    }
  }

  private var providers: some View {
    VStack(spacing: 12) {
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
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
      }
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
      Text("or use an email code")
        .font(.subheadline)
        .padding(.top, 8)
    }
    .disabled(model.activity != .idle)
  }

  @ViewBuilder private var emailCode: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch model.step {
      case .email:
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
        Button {
          submit(model.sendCode)
        } label: {
          ProgressLabel("Send sign-in code", busy: model.activity == .sendingCode)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!model.canSendCode)
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
          ProgressLabel("Sign in", busy: model.activity == .checkingCode)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!model.canCheckCode)
        Button("Use another email or request a new code") {
          model.useAnotherEmail()
        }
        .disabled(model.activity != .idle)
        .frame(maxWidth: .infinity)
      }
    }
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
