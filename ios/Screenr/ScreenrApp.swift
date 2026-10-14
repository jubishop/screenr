import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
  private let services: AppServices
  private let logFile: LogFile?
  private let telemetry: Telemetry

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
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: ProcessInfo.processInfo.arguments,
        observer: telemetry
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
    // Error reports stop naming the member once the session ends.
    services.session.onEnd { telemetry.signOut() }
  }

  var body: some Scene {
    WindowGroup {
      AppRoot()
        .screenrServices(services)
    }
  }
}
