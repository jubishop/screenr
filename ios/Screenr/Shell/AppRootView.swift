import ScreenrKit
import SwiftUI

// The app's root, which follows the session: the required update, sign-in,
// first-time setup, or the tabs. Sign-in and setup are their own screens, so
// they change without touching the tabs. Links open here in every state; the
// router keeps them until the tabs show, and an invitation's token waits in
// `PendingInvitation` for sign-in and setup.
struct AppRootView: View {
  @Environment(SessionStore.self) private var session
  @Environment(ShellModel.self) private var shell
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      switch session.phase {
      case .updateRequired:
        RequiredUpdateView()
      case .signedOut:
        SignInView()
      case .signedIn:
        SignedInView()
      }
    }
    .onOpenURL { url in shell.router.open(url) }
    .onChange(of: scenePhase, initial: true) { _, phase in
      shell.appActivityChanged(phase == .active)
    }
  }
}

// A signed-in member: setup until they have a profile, then the tabs.
private struct SignedInView: View {
  @Environment(ShellModel.self) private var shell

  var body: some View {
    switch shell.account {
    case .checking:
      ProgressView("Loading")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await shell.checkAccount() }
    case .needsSetup:
      SetupView()
    case .failed(let error):
      ReadFailureView(error: error) {
        await shell.checkAccount()
      }
    case .ready:
      MainTabView()
    }
  }
}
