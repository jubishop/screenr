import ScreenrKit
import SwiftUI

@main
struct ScreenrApp: App {
<<<<<<< HEAD
  private let services: AppServices
=======
  private let configuration: AppConfiguration
  private let logFile: LogFile?
  private let telemetry: Telemetry
>>>>>>> 99d70c8 (✨ feat(ios): Add in-house logging and Release-only Sentry)

  init() {
    let configuration: AppConfiguration
    do {
      configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    } catch {
      fatalError("The build's Screenr settings are invalid: \(error)")
    }
<<<<<<< HEAD
    do {
      services = try AppServices(
        configuration: configuration,
        arguments: ProcessInfo.processInfo.arguments
      )
    } catch {
      fatalError("Screenr could not start its API client: \(error)")
    }
=======
    // Sentry starts first, so it can catch a crash in the rest of launch.
    telemetry = Telemetry(configuration: configuration)
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
>>>>>>> 99d70c8 (✨ feat(ios): Add in-house logging and Release-only Sentry)
  }

  var body: some Scene {
    WindowGroup {
      WordmarkView()
        .screenrServices(services)
    }
  }
}
