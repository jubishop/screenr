import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  private let services: AppServices
  private let shell: ShellModel
  private let logFile: LogFile?
  private let telemetry: Telemetry
  private let colorScheme: ColorScheme?

  init() {
    let configuration: AppConfiguration
    do {
      configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The build's Screenr settings are invalid: \(error)")
    }
    // Sentry starts first, so it can catch a crash in the rest of launch.
    let telemetry = Telemetry(configuration: configuration)
    self.telemetry = telemetry
    if let directory = LogFile.directory(appGroup: configuration.appGroup) {
      let logFile = LogFile(directory: directory, name: "app")
      LogRouter.shared.add(logFile)
      self.logFile = logFile
    } else {
      logFile = nil
      Log.app.fault("The app group container is unavailable, so the log file is off")
    }
    Log.app.info(
      "Launched",
      .label("variant", configuration.variant),
      .label("telemetry", telemetry.state)
    )
    let arguments = ProcessInfo.processInfo.arguments
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: arguments,
        observer: telemetry,
        feedback: telemetry.feedback,
        logFile: logFile
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
    // Error reports name the signed-in member's opaque user ID once a screen
    // shows who they are, and stop when the session ends; the next member
    // starts over at the friends feed.
    let shell = ShellModel(api: services.api, router: Router(invitation: services.invitation)) {
      viewer in telemetry.signIn(userID: viewer.userId)
    }
    self.shell = shell
    services.session.onEnd {
      telemetry.signOut()
      shell.sessionEnded()
    }
    if let link = LaunchLink.url(in: arguments, variant: configuration.variant) {
      shell.router.open(link)
    }
    colorScheme = LaunchAppearance.colorScheme(in: arguments, variant: configuration.variant)
  }

  var body: some Scene {
    WindowGroup {
      AppRootView()
        .screenrServices(services)
        .environment(shell)
        .preferredColorScheme(colorScheme)
    }
  }
}
