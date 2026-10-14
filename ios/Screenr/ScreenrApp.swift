import AppIntents
import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  private let services: AppServices
  private let shell: ShellModel
  private let push: PushNotifications
  private let logFile: LogFile?
  private let telemetry: Telemetry
  private let colorScheme: ColorScheme?

  init() {
    let configuration: AppConfiguration
    let pushTarget: PushTarget
    do {
      let info = Bundle.main.infoDictionary ?? [:]
      configuration = try AppConfiguration(infoDictionary: info)
      pushTarget = try AppConfiguration.pushTarget(infoDictionary: info)
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
    // Screenr Dev's share extension answers from the same fixtures.
    FixtureHandoff(configuration: configuration)?.keep(arguments)
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: arguments,
        observer: telemetry,
        feedback: telemetry.feedback,
        logFile: logFile,
        push: SystemPush()
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
    // Spotlight on this device finds the titles the member's screens show
    // they interacted with, with posters the image cache already holds. It
    // forgets them when the session ends.
    let images = services.images
    let imageCache = services.imageCache
    let spotlight = TitleSpotlight(
      index: SpotlightIndex { path in
        guard let request = images.poster(path) else { return nil }
        return imageCache.cachedResponse(for: request)?.data
      },
      session: services.session
    )
    // Error reports name the signed-in member's opaque user ID once a screen
    // shows who they are, and stop when the session ends; the next member
    // starts over at the friends feed.
    let shell = ShellModel(
      api: services.api,
      router: Router(invitation: services.invitation),
      onViewer: { viewer in telemetry.signIn(userID: viewer.userId) },
      onScreen: { screen in spotlight.screenLoaded(screen) }
    )
    self.shell = shell
    // The app passes its push system, so the services always have one.
    guard let pushSystem = services.push else {
      fatalError("Screenr started without its push system")
    }
    let push = PushNotifications(
      api: services.api,
      shell: shell,
      system: pushSystem,
      target: pushTarget
    )
    self.push = push
    AppDelegate.push = push
    services.session.onEnd {
      telemetry.signOut()
      shell.sessionEnded()
      push.sessionEnded()
    }
    // Siri and the Shortcuts app run the intents in this process, which
    // registers what their `@Dependency` properties read before any runs.
    // The framework declares its shared manager `nonisolated(unsafe)`.
    let shortcuts = ShortcutActions(
      api: services.api,
      session: services.session,
      router: shell.router,
      spotlight: spotlight
    )
    unsafe AppDependencyManager.shared.add(dependency: shortcuts)
    if let link = LaunchLink.url(in: arguments, variant: configuration.variant) {
      shell.router.open(link)
    }
    colorScheme = LaunchAppearance.colorScheme(in: arguments, variant: configuration.variant)
    if let tap = PushTap.launch(arguments, variant: configuration.variant) {
      Task { await push.open(tap) }
    }
  }

  var body: some Scene {
    WindowGroup {
      AppRootView()
        .screenrServices(services)
        .environment(shell)
        .environment(push)
        .preferredColorScheme(colorScheme)
    }
  }
}
