import AuthenticationServices
import ScreenrKit
import SwiftUI

// The account's sign-in methods. Email codes always sign in to it; Google
// and Sign in with Apple join it only when the member links them here.
struct SignInMethodsSection: View {
  let settings: SettingsContext
  @Environment(\.screenrAPI) private var api
  @Environment(\.identityProviders) private var providers

  init(_ settings: SettingsContext) {
    self.settings = settings
  }

  var body: some View {
    let refresh = settings.refresh
    SignInMethods(
      page: settings.page,
      model: AccountLinkModel(api: api, providers: injectedProviders) { await refresh() }
    )
  }

  private var injectedProviders: IdentityProviders {
    guard let providers else {
      preconditionFailure("Inject the services with .screenrServices(_:) before linking")
    }
    return providers
  }
}

private struct SignInMethods: View {
  let page: AccountScreen
  @State private var model: AccountLinkModel
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession
  @Environment(\.colorScheme) private var colorScheme
  @ScaledMetric(relativeTo: .body) private var appleButtonHeight = 44.0

  init(page: AccountScreen, model: AccountLinkModel) {
    self.page = page
    _model = State(initialValue: model)
  }

  var body: some View {
    Section {
      SettingRow("Email code", value: page.email ?? "On")
      google
      apple
    } header: {
      SectionHeading("Sign-in methods")
    } footer: {
      SettingsFooter(
        text:
          "Keep the same profile and friendships when you change sign-in methods. Email codes sign you in to this same account; use the email address you joined with. Connect an account with that same address.",
        failure: model.failure,
        status: linkedStatus
      )
    }
    .disabled(model.state != .idle)
  }

  private var linkedStatus: String? {
    guard let linked = model.linked else { return nil }
    return "\(linked.name) connected."
  }

  @ViewBuilder private var google: some View {
    if page.googleConnected {
      SettingRow("Google", value: "Connected")
    } else if page.googleEnabled {
      Button {
        Task {
          await model.linkGoogle(
            using: SystemWebAuthenticator(session: webAuthenticationSession)
          )
        }
      } label: {
        Label(
          model.state == .linking(.google) ? "Connecting…" : "Connect Google",
          systemImage: "g.circle"
        )
      }
    } else {
      SettingRow("Google", value: "Not available")
    }
  }

  @ViewBuilder private var apple: some View {
    if page.appleConnected == true {
      SettingRow("Apple", value: "Connected")
    } else if page.appleEnabled == true {
      switch model.authorization {
      case .system:
        SignInWithAppleButton(.continue) { request in
          model.prepare(request)
        } onCompletion: { result in
          Task { await model.completeApple(result) }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: appleButtonHeight)
      case .fixture:
        Button {
          Task { await model.linkFixtureApple() }
        } label: {
          Label(
            model.state == .linking(.apple) ? "Connecting…" : "Connect Apple",
            systemImage: "apple.logo"
          )
        }
      }
    }
  }
}
