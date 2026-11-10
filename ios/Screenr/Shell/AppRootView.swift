import ScreenrKit
import SwiftUI

// The app's root. At each launch the age check runs first, and where the law
// requires it, the app goes no further for anyone not shown to be an adult.
// Then it follows the session: the required update, sign-in, first-time
// setup, or the tabs. Sign-in and setup are their own screens, so they change
// without touching the tabs. Links open here in every state; the router keeps
// them until the tabs show, even when the age check or an expired session
// comes first, and an invitation's token waits in `PendingInvitation` for
// sign-in and setup. A Spotlight result opens its title the same way. Each
// invitation link, and one an earlier launch kept, is checked with the server
// once the age check passes. The scene phase reaches the live screens, and the
// visit tracker, which marks the first screen read after each return to the
// foreground as a visit.
struct AppRootView: View {
  @Environment(AgeCheck.self) private var ageCheck
  @Environment(ShellModel.self) private var shell
  @Environment(\.visitTracker) private var visits
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      switch ageCheck.phase {
      case .checking:
        AgeCheckView()
      case .refused(let refusal):
        AdultsOnlyView(refusal: refusal)
      case .allowed:
        SessionView()
      }
    }
    .onOpenURL { url in shell.router.open(url) }
    .onContinueUserActivity(TitleSpotlight.selectionActivity) { activity in
      if let destination = TitleSpotlight.destination(for: activity) {
        shell.router.open(destination)
      }
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      // The tracker learns of a return before the screens read again.
      visits?.sceneChanged(to: phase)
      shell.appActivityChanged(phase == .active)
    }
  }
}

// The app for someone the age check let in, by the session's phase.
private struct SessionView: View {
  @Environment(SessionStore.self) private var session
  @Environment(PendingInvitation.self) private var invitation
  @Environment(\.screenrAPI) private var api

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
    .task(id: invitation.token) { await invitation.check(using: api) }
  }
}

// A signed-in member: setup until they have a profile, then the tabs. A new
// member who just joined is asked to allow notifications as Circle opens.
private struct SignedInView: View {
  @Environment(ShellModel.self) private var shell
  @Environment(PushNotifications.self) private var push

  var body: some View {
    account
      .onChange(of: shell.account) { previous, account in
        if previous == .needsSetup, account == .ready {
          Task { await push.askForPermission() }
        }
      }
  }

  @ViewBuilder private var account: some View {
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
